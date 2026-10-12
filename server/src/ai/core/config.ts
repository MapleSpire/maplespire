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

import type { Queryable } from '../../readModel/types.js'
import { aiCryptoAvailable, decryptSecret, encryptSecret, keyHint } from './crypto.js'

/**
 * Org AI provider configuration (BYOK). The API key is encrypted at rest
 * (ai/crypto.ts); reads return only the masked hint unless explicitly resolving
 * for a model call.
 */

export const AI_PROVIDERS = ['openai', 'anthropic', 'google', 'openai-compatible', 'lmstudio'] as const
export type AiProviderId = (typeof AI_PROVIDERS)[number]
export const LMSTUDIO_DEFAULT_BASE_URL = 'http://localhost:1234/v1'

/** Providers where an API key is optional (local/self-hosted endpoints). */
const KEYLESS_OK = new Set<AiProviderId>(['openai-compatible', 'lmstudio'])
/** Providers that REQUIRE a base URL. */
const NEEDS_BASE_URL = new Set<AiProviderId>(['openai-compatible'])
/** Hosted SDK providers always use their vendor endpoint. Letting an org
 * override it would turn a saved BYOK key into an SSRF/exfiltration primitive. */
const OFFICIAL_ENDPOINT_PROVIDERS = new Set<AiProviderId>(['openai', 'anthropic', 'google'])

export function normalizedBaseUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  try {
    const url = new URL(value.trim())
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/+$/, '')
  } catch {
    return value.trim().replace(/\/+$/, '')
  }
}

export function effectiveAiBaseUrl(provider: string, value: string | null | undefined): string | null {
  const normalized = provider === 'lmstudio' && !value?.trim()
    ? normalizedBaseUrl(LMSTUDIO_DEFAULT_BASE_URL)
    : normalizedBaseUrl(value)
  if (provider !== 'lmstudio' || !normalized) return normalized
  try {
    const url = new URL(normalized)
    // LM Studio exposes its OpenAI-compatible API below /v1. Accept the host
    // root users naturally paste, but keep an explicit non-root proxy path.
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/v1'
    return normalizedBaseUrl(url.toString())
  } catch {
    return normalized
  }
}

function allowedCustomEndpoints(): Set<string> {
  return new Set(
    (process.env.AI_ALLOWED_BASE_URLS ?? '')
      .split(',')
      .map((value) => normalizedBaseUrl(value))
      .filter((value): value is string => !!value)
  )
}

/** Credential reuse is safe only for the exact same provider endpoint. */
export function sameAiCredentialTarget(
  existing: Pick<OrgAiConfigPublic, 'provider' | 'baseUrl'> | null | undefined,
  next: Pick<SaveAiConfigInput, 'provider' | 'baseUrl'>
): boolean {
  return !!existing
    && existing.provider === next.provider
    && effectiveAiBaseUrl(existing.provider, existing.baseUrl) === effectiveAiBaseUrl(next.provider, next.baseUrl)
}

export const INVALID_SAVED_AI_CONFIG_CODE = 'ai-config-invalid'

export class InvalidSavedAiConfigError extends Error {
  readonly code = INVALID_SAVED_AI_CONFIG_CODE

  constructor(readonly reason: 'invalid' | 'key-unavailable') {
    super(
      reason === 'key-unavailable'
        ? 'The saved AI provider key is unavailable. Re-enter it in the organization AI settings.'
        : 'The saved AI configuration is no longer permitted. Review and save it again in the organization AI settings.'
    )
    this.name = 'InvalidSavedAiConfigError'
  }
}

export function isInvalidSavedAiConfigError(error: unknown): error is InvalidSavedAiConfigError {
  return error instanceof InvalidSavedAiConfigError
}

export class AiConfigInputError extends Error {
  readonly code = 'ai-config-invalid-input'

  constructor(message: string) {
    super(message)
    this.name = 'AiConfigInputError'
  }
}

export function isAiConfigInputError(error: unknown): error is AiConfigInputError {
  return error instanceof AiConfigInputError
}

export interface OrgAiConfigPublic {
  provider: AiProviderId
  model: string
  baseUrl: string | null
  keyHint: string | null
  hasKey: boolean
  enabled: boolean
  updatedAt: string
}

export interface ResolvedAiConfig {
  provider: AiProviderId
  model: string
  baseUrl: string | null
  apiKey: string | null
}

export interface SaveAiConfigInput {
  provider: string
  model: string
  baseUrl?: string | null
  /** Plaintext key. Omitted/undefined = keep the existing stored key. Empty
   * string or null = clear the stored key. */
  apiKey?: string | null
  enabled?: boolean
}

interface AiConfigRow extends Record<string, unknown> {
  provider: string
  model: string
  base_url: string | null
  key_hint: string | null
  api_key_enc: string | null
  enabled: boolean
  updated_at: string | Date
}

interface ReleasableQueryable extends Queryable {
  release(): void
}

interface ConnectableQueryable extends Queryable {
  connect?: () => Promise<ReleasableQueryable>
}

function publicConfigFromRow(row: AiConfigRow): OrgAiConfigPublic {
  return {
    provider: row.provider as AiProviderId,
    model: String(row.model),
    baseUrl: row.base_url ?? null,
    keyHint: row.key_hint ?? null,
    hasKey: !!row.api_key_enc,
    enabled: row.enabled !== false,
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

/** Validation returns a user-facing message, or null when the input is ok. */
export function validateAiConfig(
  input: SaveAiConfigInput,
  hasStoredKey: boolean,
  existing?: Pick<OrgAiConfigPublic, 'provider' | 'baseUrl'> | null
): string | null {
  if (!AI_PROVIDERS.includes(input.provider as AiProviderId)) {
    return `unknown provider "${input.provider}" (expected one of: ${AI_PROVIDERS.join(', ')})`
  }
  const provider = input.provider as AiProviderId
  if (typeof input.model !== 'string' || !input.model.trim()) return 'model is required'
  if (NEEDS_BASE_URL.has(provider) && !(input.baseUrl ?? '').trim()) {
    return 'base URL is required for an OpenAI-compatible endpoint'
  }
  if (OFFICIAL_ENDPOINT_PROVIDERS.has(provider) && (input.baseUrl ?? '').trim()) {
    return 'custom base URLs are not allowed for hosted providers'
  }
  const customBaseUrl = provider === 'lmstudio'
    ? (input.baseUrl?.trim() || LMSTUDIO_DEFAULT_BASE_URL)
    : input.baseUrl
  if (customBaseUrl) {
    try {
      const u = new URL(customBaseUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'base URL must be http(s)'
      if (u.username || u.password || u.search || u.hash) {
        return 'base URL must not contain credentials, a query, or a fragment'
      }
      if (!allowedCustomEndpoints().has(effectiveAiBaseUrl(provider, customBaseUrl)!)) {
        return 'base URL is not permitted by the server AI endpoint allowlist'
      }
    } catch {
      return 'base URL is not a valid URL'
    }
  }
  const storedKeyCanBeReused = hasStoredKey && (!existing || sameAiCredentialTarget(existing, input))
  const willHaveKey = input.apiKey !== undefined
    ? !!(input.apiKey && input.apiKey.trim())
    : storedKeyCanBeReused
  if (!willHaveKey && !KEYLESS_OK.has(provider)) return 'an API key is required for this provider'
  if (input.apiKey && input.apiKey.trim() && !aiCryptoAvailable()) {
    return 'server cannot store keys: set AI_KEY_SECRET (or AUTH_SECRET) on the server first'
  }
  return null
}

export async function getOrgAiConfig(db: Queryable, orgId: string): Promise<OrgAiConfigPublic | null> {
  const { rows } = await db.query<AiConfigRow>(
    `SELECT provider, model, base_url, key_hint, api_key_enc, enabled, updated_at FROM org_ai_config WHERE org_id = $1`,
    [orgId]
  )
  const r = rows[0]
  if (!r) return null
  return publicConfigFromRow(r)
}

async function saveOrgAiConfigLocked(
  db: Queryable,
  orgId: string,
  input: SaveAiConfigInput,
  updatedBy: string | null
): Promise<OrgAiConfigPublic> {
  // SELECT FOR UPDATE cannot lock a row before its first insert, so an
  // organization-scoped transaction lock closes that race as well.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`org-ai-config:${orgId}`])
  const { rows: currentRows } = await db.query<AiConfigRow>(
    `SELECT provider, model, base_url, key_hint, api_key_enc, enabled, updated_at
     FROM org_ai_config WHERE org_id = $1 FOR UPDATE`,
    [orgId]
  )
  const current = currentRows[0]
  const currentPublic = current ? publicConfigFromRow(current) : null
  const validationError = validateAiConfig(input, !!current?.api_key_enc, currentPublic)
  if (validationError) throw new AiConfigInputError(validationError)
  const trimmedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : input.apiKey
  let encryptedKey: string | null = null
  let hint: string | null = null
  if (trimmedKey) {
    encryptedKey = encryptSecret(trimmedKey)
    hint = keyHint(trimmedKey)
  } else if (
    trimmedKey === undefined
    && current
    && sameAiCredentialTarget(currentPublic, input)
  ) {
    encryptedKey = current.api_key_enc
    hint = current.key_hint
  }

  const { rows } = await db.query<AiConfigRow>(
    `INSERT INTO org_ai_config
       (org_id, provider, model, base_url, api_key_enc, key_hint, enabled, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (org_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       base_url = EXCLUDED.base_url,
       api_key_enc = EXCLUDED.api_key_enc,
       key_hint = EXCLUDED.key_hint,
       enabled = EXCLUDED.enabled,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING provider, model, base_url, key_hint, api_key_enc, enabled, updated_at`,
    [
      orgId,
      input.provider,
      input.model.trim(),
      effectiveAiBaseUrl(input.provider, input.baseUrl),
      encryptedKey,
      hint,
      input.enabled ?? true,
      updatedBy,
    ]
  )
  const saved = rows[0]
  if (!saved) throw new Error('ai config write did not persist')
  return publicConfigFromRow(saved)
}

export async function saveOrgAiConfig(
  db: Queryable,
  orgId: string,
  input: SaveAiConfigInput,
  updatedBy: string | null
): Promise<OrgAiConfigPublic> {
  const connectable = db as ConnectableQueryable
  if (typeof connectable.connect !== 'function') {
    // A PoolClient/test double is already transaction-scoped by its caller.
    return saveOrgAiConfigLocked(db, orgId, input, updatedBy)
  }
  const client = await connectable.connect()
  try {
    await client.query('BEGIN')
    const saved = await saveOrgAiConfigLocked(client, orgId, input, updatedBy)
    await client.query('COMMIT')
    return saved
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function deleteOrgAiConfig(db: Queryable, orgId: string): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM org_ai_config WHERE org_id = $1`, [orgId])
  return (rowCount ?? 0) > 0
}

/** Decrypted config for actually calling the model. Distinguishes "not
 * configured" (null) from "configured but key undecryptable" (throws — the
 * admin must re-enter the key, e.g. after an AI_KEY_SECRET rotation). */
export async function resolveOrgAiConfig(db: Queryable, orgId: string): Promise<ResolvedAiConfig | null> {
  const { rows } = await db.query(
    `SELECT provider, model, base_url, api_key_enc, enabled FROM org_ai_config WHERE org_id = $1`,
    [orgId]
  )
  const r = rows[0]
  if (!r || r.enabled === false) return null
  let apiKey: string | null = null
  if (r.api_key_enc) {
    apiKey = decryptSecret(String(r.api_key_enc))
    if (apiKey === null) {
      throw new InvalidSavedAiConfigError('key-unavailable')
    }
  }
  const resolved: ResolvedAiConfig = {
    provider: r.provider as AiProviderId,
    model: String(r.model),
    baseUrl: effectiveAiBaseUrl(String(r.provider), (r.base_url as string | null) ?? null),
    apiKey,
  }
  const validationError = validateAiConfig(
    {
      provider: resolved.provider,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
    },
    false
  )
  if (validationError) throw new InvalidSavedAiConfigError('invalid')
  return resolved
}

export interface OrgAiConfigStatus {
  config: OrgAiConfigPublic | null
  configured: boolean
  configurationError?: string
}

/** Member-readable status projection that never exposes validation details. */
export async function getOrgAiConfigStatus(db: Queryable, orgId: string): Promise<OrgAiConfigStatus> {
  const config = await getOrgAiConfig(db, orgId)
  if (!config?.enabled) return { config, configured: false }
  try {
    return { config, configured: !!(await resolveOrgAiConfig(db, orgId)) }
  } catch (error) {
    if (!isInvalidSavedAiConfigError(error)) throw error
    return { config, configured: false, configurationError: error.message }
  }
}
