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

import type { Pool } from 'pg'

/**
 * AI Assist substrate tables (org model-key config, API tokens for MCP/agents,
 * OAuth clients+codes for the remote MCP server). Idempotent, same
 * CREATE-IF-NOT-EXISTS + additive-ALTER convention as db.ts / auth/schema.ts.
 */
export async function ensureAiSchema(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    // One AI provider config per org. The key is stored ONLY encrypted
    // (ai/crypto.ts AES-256-GCM blob); `key_hint` is the masked display tail.
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_ai_config (
        org_id      TEXT PRIMARY KEY,
        provider    TEXT NOT NULL,
        model       TEXT NOT NULL,
        base_url    TEXT,
        api_key_enc TEXT,
        key_hint    TEXT,
        enabled     BOOLEAN NOT NULL DEFAULT true,
        updated_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // Bearer tokens for the MCP server + tool REST API. `kind='pat'` rows are
    // user-minted personal access tokens; `kind='oauth'` rows are minted by the
    // OAuth token endpoint (with a rotating refresh token). Only sha256 hashes
    // are stored; `token_prefix` is the display handle ("bvr_ab12…").
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_api_tokens (
        id                 TEXT PRIMARY KEY,
        kind               TEXT NOT NULL DEFAULT 'pat',
        user_id            TEXT NOT NULL,
        org_id             TEXT,
        name               TEXT NOT NULL,
        token_hash         TEXT NOT NULL UNIQUE,
        token_prefix       TEXT NOT NULL,
        scopes             TEXT[] NOT NULL DEFAULT '{mcp}',
        client_id          TEXT,
        refresh_token_hash TEXT UNIQUE,
        last_used_at       TIMESTAMPTZ,
        expires_at         TIMESTAMPTZ,
        revoked_at         TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_tokens_user ON ai_api_tokens(user_id, created_at DESC)`)

    // Dynamically-registered OAuth clients (RFC 7591) for the remote MCP server.
    // `token_endpoint_auth_method='none'` (public client + PKCE) is the norm for
    // MCP hosts (Claude Code, codex, …).
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_oauth_clients (
        client_id                  TEXT PRIMARY KEY,
        client_secret_hash         TEXT,
        client_name                TEXT,
        redirect_uris              JSONB NOT NULL DEFAULT '[]',
        token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // Short-lived authorization codes (10 min, single-use) with PKCE.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_oauth_codes (
        code                  TEXT PRIMARY KEY,
        client_id             TEXT NOT NULL,
        user_id               TEXT NOT NULL,
        org_id                TEXT,
        redirect_uri          TEXT NOT NULL,
        code_challenge        TEXT,
        code_challenge_method TEXT,
        scope                 TEXT,
        expires_at            TIMESTAMPTZ NOT NULL,
        used_at               TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // AI Assist chat conversations — the panel's history. The full UIMessage
    // array is stored as JSONB (the AI SDK's message parts round-trip
    // verbatim); scoped per workspace + user (`user_id` NULL below auth = the
    // shared anonymous history of an open dev stack).
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_conversations (
        id           TEXT PRIMARY KEY,
        org_id       TEXT,
        user_id      TEXT,
        landscape_id TEXT NOT NULL,
        version_id   TEXT NOT NULL,
        title        TEXT NOT NULL DEFAULT 'New conversation',
        messages     JSONB NOT NULL DEFAULT '[]',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_ai_conversations_scope
       ON ai_conversations(landscape_id, version_id, user_id, updated_at DESC)`
    )
  } finally {
    client.release()
  }
}
