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

/**
 * REST client for the AI Assist feature (server/src/ai). Fetch conventions of
 * `lib/orgAdmin/api.ts`: same API_BASE resolution, `credentials: 'include'`
 * (session cookie), typed error carrying {status, code}.
 */

import { API_BASE } from '../api/base'

export const AI_API_BASE = API_BASE

/**
 * Absolute endpoint shown to humans and external agents. Production builds use
 * an empty VITE_SYNC_API_URL for same-origin requests, but a bare `/mcp` is not
 * a usable remote-agent configuration. Resolve that case to the browser origin
 * while keeping API requests themselves same-origin.
 */
export function resolveAiPublicBaseUrl(
  configuredBase = AI_API_BASE,
  browserOrigin = typeof window === 'undefined' ? '' : window.location.origin
): string {
  return (configuredBase || browserOrigin).replace(/\/$/, '')
}

export class AiApiError extends Error {
  status: number
  code: string | null

  constructor(status: number, code: string | null, message: string) {
    super(message)
    this.name = 'AiApiError'
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AI_API_BASE}${path}`, {
    credentials: 'include',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const code = typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : null
    const message = typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message
      : code ?? `Request failed: HTTP ${res.status}`
    throw new AiApiError(res.status, code, message)
  }
  return body as T
}

// ── Status (panel gating) ────────────────────────────────────────────────────

export interface AiStatus {
  configured: boolean
  cryptoAvailable: boolean
  orgId: string | null
  provider: string | null
  model: string | null
  canWrite: boolean
  configurationError?: string
  workspaceError?: string
}

export function getAiStatus(landscapeId: string, versionId: string): Promise<AiStatus> {
  const params = new URLSearchParams({ landscapeId, versionId })
  return request(`/api/ai/status?${params}`)
}

// ── Org AI config (BYOK) ─────────────────────────────────────────────────────

export interface AiConfigPublic {
  provider: string
  model: string
  baseUrl: string | null
  keyHint: string | null
  hasKey: boolean
  enabled: boolean
  updatedAt: string
}

export interface AiConfigResponse {
  config: AiConfigPublic | null
  providers: string[]
  cryptoAvailable: boolean
}

export function getAiConfig(orgId: string): Promise<AiConfigResponse> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/ai-config`)
}

export interface SaveAiConfigInput {
  provider: string
  model: string
  baseUrl?: string | null
  /** Omit to keep the stored key; ''/null clears it. */
  apiKey?: string | null
  enabled?: boolean
}

export function saveAiConfig(orgId: string, input: SaveAiConfigInput): Promise<{ config: AiConfigPublic }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/ai-config`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deleteAiConfig(orgId: string): Promise<{ deleted: boolean }> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/ai-config`, { method: 'DELETE' })
}

export interface AiProbeResult {
  ok: boolean
  latencyMs: number
  message?: string
}

export function testAiConfig(orgId: string, input?: Partial<SaveAiConfigInput>): Promise<AiProbeResult> {
  return request(`/api/orgs/${encodeURIComponent(orgId)}/ai-config/test`, {
    method: 'POST',
    body: JSON.stringify(input ?? {}),
  })
}

// ── Conversations (panel history) ───────────────────────────────────────────

export interface AiConversationMeta {
  id: string
  title: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

function scopeParams(landscapeId: string, versionId: string): string {
  return new URLSearchParams({ landscapeId, versionId }).toString()
}

export function listAiConversations(
  landscapeId: string,
  versionId: string
): Promise<{ conversations: AiConversationMeta[] }> {
  return request(`/api/ai/conversations?${scopeParams(landscapeId, versionId)}`)
}

export function getAiConversation(
  landscapeId: string,
  versionId: string,
  id: string
): Promise<{ meta: AiConversationMeta; messages: unknown[] }> {
  return request(`/api/ai/conversations/${encodeURIComponent(id)}?${scopeParams(landscapeId, versionId)}`)
}

export function deleteAiConversation(
  landscapeId: string,
  versionId: string,
  id: string
): Promise<{ deleted: boolean }> {
  return request(`/api/ai/conversations/${encodeURIComponent(id)}?${scopeParams(landscapeId, versionId)}`, {
    method: 'DELETE',
  })
}

// ── Personal API tokens (MCP / agents) ──────────────────────────────────────

export interface AiTokenInfo {
  id: string
  kind: 'pat' | 'oauth'
  name: string
  tokenPrefix: string
  scopes: string[]
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

export function listAiTokens(): Promise<{ tokens: AiTokenInfo[] }> {
  return request('/api/me/ai-tokens')
}

export function createAiToken(name: string, expiresInDays?: number): Promise<{ token: string; info: AiTokenInfo }> {
  return request('/api/me/ai-tokens', {
    method: 'POST',
    body: JSON.stringify({ name, ...(expiresInDays ? { expiresInDays } : {}) }),
  })
}

export function revokeAiToken(id: string): Promise<{ revoked: boolean }> {
  return request(`/api/me/ai-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
