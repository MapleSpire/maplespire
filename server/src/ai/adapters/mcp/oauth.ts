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

import { createHash, randomBytes } from 'node:crypto'
import express, { type Express, type Request, type Response } from 'express'
import { pool } from '../../../db.js'
import { authStage } from '../../../auth/middleware.js'
import { createAiToken, findByRefreshToken, revokeTokenById } from '../../core/tokens.js'
import { hashToken } from '../../core/crypto.js'
import { requestPublicBaseUrl } from '../publicBaseUrl.js'

/**
 * Minimal OAuth 2.1 authorization server for the remote MCP endpoint —
 * enough for MCP hosts (Claude Code, claude.ai, codex, …) to connect via the
 * standard discovery → dynamic client registration → authorization-code +
 * PKCE (S256) → token flow, with rotating refresh tokens:
 *
 *   GET  /.well-known/oauth-authorization-server   (metadata)
 *   POST /api/auth/mcp/register                    (RFC 7591 DCR, public clients)
 *   GET  /api/auth/mcp/authorize                   (consent page; session cookie)
 *   POST /api/auth/mcp/authorize                   (consent decision)
 *   POST /api/auth/mcp/token                       (code + refresh grants)
 *
 * The `/api/auth/` prefix is ALLOWLISTED by requireAuth (like every other
 * auth-flow route), so the endpoints work at every auth stage; the flow
 * itself requires a signed-in session at the consent step. Access tokens are
 * `ai_api_tokens` rows (kind='oauth') — the same verification path as PATs.
 */

const CODE_TTL_MS = 10 * 60 * 1000
const ACCESS_TTL_S = 30 * 24 * 60 * 60 // 30 days
const REFRESH_PREFIX = 'bvrr_'

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

function param(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function isHttpUrl(u: string): boolean {
  try {
    const url = new URL(u)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

interface ClientRow {
  client_id: string
  client_name: string | null
  redirect_uris: string[]
}

async function loadClient(clientId: string): Promise<ClientRow | null> {
  const { rows } = await pool.query<{ client_id: string; client_name: string | null; redirect_uris: unknown }>(
    'SELECT client_id, client_name, redirect_uris FROM ai_oauth_clients WHERE client_id = $1',
    [clientId]
  )
  const r = rows[0]
  if (!r) return null
  return {
    client_id: r.client_id,
    client_name: r.client_name,
    redirect_uris: Array.isArray(r.redirect_uris) ? (r.redirect_uris as string[]) : [],
  }
}

function tokenError(res: Response, status: number, error: string, description?: string): void {
  res.status(status).json({ error, ...(description ? { error_description: description } : {}) })
}

export function registerMcpOAuthRoutes(app: Express): void {
  const form = express.urlencoded({ extended: false })

  // ── AS metadata (RFC 8414) ────────────────────────────────────────────────
  const metadata = (req: Request, res: Response) => {
    const base = requestPublicBaseUrl(req)
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/api/auth/mcp/authorize`,
      token_endpoint: `${base}/api/auth/mcp/token`,
      registration_endpoint: `${base}/api/auth/mcp/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
    })
  }
  app.get('/.well-known/oauth-authorization-server', metadata)
  app.get('/.well-known/oauth-authorization-server/mcp', metadata)

  // ── Dynamic client registration (public clients + PKCE) ─────────────────
  app.post('/api/auth/mcp/register', (req, res) => {
    void (async () => {
      const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === 'string') : []
      if (uris.length === 0 || !uris.every(isHttpUrl)) {
        tokenError(res, 400, 'invalid_client_metadata', 'redirect_uris must be one or more http(s) URLs')
        return
      }
      const clientId = randomBytes(16).toString('base64url')
      const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 120) : null
      await pool.query(
        `INSERT INTO ai_oauth_clients (client_id, client_name, redirect_uris, token_endpoint_auth_method)
         VALUES ($1, $2, $3, 'none')`,
        [clientId, clientName, JSON.stringify(uris)]
      )
      res.status(201).json({
        client_id: clientId,
        client_name: clientName,
        redirect_uris: uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      })
    })().catch((err) => {
      console.error('[mcp-oauth] register failed:', err)
      tokenError(res, 500, 'server_error')
    })
  })

  // ── Authorize: consent page (GET) + decision (POST) ─────────────────────
  const handleAuthorize = (req: Request, res: Response) => {
    void (async () => {
      const src = req.method === 'POST' ? (req.body as Record<string, unknown>) : (req.query as Record<string, unknown>)
      const clientId = param(src.client_id)
      const redirectUri = param(src.redirect_uri)
      const state = param(src.state)
      const codeChallenge = param(src.code_challenge)
      const codeChallengeMethod = param(src.code_challenge_method) || 'S256'
      const scope = param(src.scope) || 'mcp'
      const decision = param(src.decision)

      const client = clientId ? await loadClient(clientId) : null
      if (!client || !client.redirect_uris.includes(redirectUri)) {
        // NEVER redirect to an unregistered URI — render the error instead.
        res.status(400).send(page('Connection failed', `<p>Unknown client or unregistered redirect URI.</p>`))
        return
      }
      const back = (params: Record<string, string>) => {
        const u = new URL(redirectUri)
        for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
        if (state) u.searchParams.set('state', state)
        res.redirect(u.toString())
      }
      if (param(src.response_type) && param(src.response_type) !== 'code') {
        back({ error: 'unsupported_response_type' })
        return
      }
      if (!codeChallenge || codeChallengeMethod !== 'S256') {
        back({ error: 'invalid_request', error_description: 'PKCE S256 required' })
        return
      }

      if (authStage() === 'off') {
        res
          .status(400)
          .send(
            page(
              'Accounts are disabled on this server',
              `<p>This MapleSpire server runs with <code>AUTH=off</code>, so there is no user to authorize. Connect without authentication (open dev mode) or enable auth and retry.</p>`
            )
          )
        return
      }
      if (!req.auth) {
        // Not signed in (in THIS browser): link to the app's login and retry
        // this URL automatically until a session cookie appears.
        const retryUrl = esc(req.originalUrl)
        const appUrl = esc(process.env.APP_URL ?? '/login')
        res
          .status(401)
          .send(
            page(
              'Sign in to continue',
              `<p>Sign in to MapleSpire in this browser, then this page will continue automatically.</p>
               <p><a href="${appUrl}" target="_blank" rel="noopener">Open MapleSpire sign-in</a></p>
               <meta http-equiv="refresh" content="3;url=${retryUrl}">`
            )
          )
        return
      }

      if (req.method === 'GET') {
        const { rows } = await pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [req.auth.userId])
        const email = rows[0]?.email ?? req.auth.userId
        const hidden = Object.entries({
          client_id: clientId,
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          scope,
          response_type: 'code',
        })
          .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
          .join('\n')
        res.send(
          page(
            'Authorize access',
            `<p><strong>${esc(client.client_name ?? 'An MCP client')}</strong> wants to access your MapleSpire architecture model as <strong>${esc(email)}</strong>.</p>
             <p>It will be able to read the model and make changes with your permissions (scope: <code>${esc(scope)}</code>).</p>
             <form method="post" action="/api/auth/mcp/authorize">
               ${hidden}
               <button name="decision" value="approve" class="approve">Authorize</button>
               <button name="decision" value="deny" class="deny">Deny</button>
             </form>`
          )
        )
        return
      }

      // POST decision
      if (decision !== 'approve') {
        back({ error: 'access_denied' })
        return
      }
      const code = `mc_${randomBytes(24).toString('hex')}`
      await pool.query(
        `INSERT INTO ai_oauth_codes (code, client_id, user_id, org_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          code,
          clientId,
          req.auth.userId,
          req.auth.orgId,
          redirectUri,
          codeChallenge,
          codeChallengeMethod,
          scope,
          new Date(Date.now() + CODE_TTL_MS),
        ]
      )
      back({ code })
    })().catch((err) => {
      console.error('[mcp-oauth] authorize failed:', err)
      if (!res.headersSent) res.status(500).send(page('Error', '<p>Authorization failed. Try again.</p>'))
    })
  }
  app.get('/api/auth/mcp/authorize', handleAuthorize)
  app.post('/api/auth/mcp/authorize', form, handleAuthorize)

  // ── Token endpoint: authorization_code + refresh_token (rotating) ───────
  app.post('/api/auth/mcp/token', form, (req, res) => {
    void (async () => {
      const body = (req.body ?? {}) as Record<string, unknown>
      const grantType = param(body.grant_type)

      if (grantType === 'authorization_code') {
        const code = param(body.code)
        const clientId = param(body.client_id)
        const redirectUri = param(body.redirect_uri)
        const verifier = param(body.code_verifier)
        const { rows } = await pool.query(
          `SELECT * FROM ai_oauth_codes WHERE code = $1`,
          [code]
        )
        const row = rows[0]
        if (!row || row.used_at || new Date(row.expires_at as string).getTime() < Date.now()) {
          tokenError(res, 400, 'invalid_grant', 'code expired, used or unknown')
          return
        }
        if (row.client_id !== clientId || (redirectUri && row.redirect_uri !== redirectUri)) {
          tokenError(res, 400, 'invalid_grant', 'client/redirect mismatch')
          return
        }
        if (!verifier || s256(verifier) !== row.code_challenge) {
          tokenError(res, 400, 'invalid_grant', 'PKCE verification failed')
          return
        }
        await pool.query(`UPDATE ai_oauth_codes SET used_at = NOW() WHERE code = $1`, [code])
        const client = await loadClient(clientId)
        await issueTokens(res, {
          userId: String(row.user_id),
          orgId: (row.org_id as string | null) ?? null,
          clientId,
          name: `MCP: ${client?.client_name ?? clientId.slice(0, 8)}`,
        })
        return
      }

      if (grantType === 'refresh_token') {
        const refresh = param(body.refresh_token)
        if (!refresh.startsWith(REFRESH_PREFIX)) {
          tokenError(res, 400, 'invalid_grant', 'unknown refresh token')
          return
        }
        const existing = await findByRefreshToken(pool, refresh)
        if (!existing) {
          tokenError(res, 400, 'invalid_grant', 'refresh token revoked or unknown')
          return
        }
        // Rotate: revoke the old access+refresh pair, mint a fresh one.
        const { rows } = await pool.query<{ name: string; client_id: string | null }>(
          'SELECT name, client_id FROM ai_api_tokens WHERE id = $1',
          [existing.tokenId]
        )
        await revokeTokenById(pool, existing.tokenId)
        await issueTokens(res, {
          userId: existing.userId,
          orgId: existing.orgId,
          clientId: rows[0]?.client_id ?? null,
          name: rows[0]?.name ?? 'MCP',
        })
        return
      }

      tokenError(res, 400, 'unsupported_grant_type')
    })().catch((err) => {
      console.error('[mcp-oauth] token grant failed:', err)
      tokenError(res, 500, 'server_error')
    })
  })
}

async function issueTokens(
  res: Response,
  opts: { userId: string; orgId: string | null; clientId: string | null; name: string }
): Promise<void> {
  const refreshToken = `${REFRESH_PREFIX}${randomBytes(20).toString('hex')}`
  const { token } = await createAiToken(pool, {
    userId: opts.userId,
    orgId: opts.orgId,
    name: opts.name,
    kind: 'oauth',
    scopes: ['mcp'],
    clientId: opts.clientId,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
  })
  res.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refreshToken,
    scope: 'mcp',
  })
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)} — MapleSpire</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f6f7f9;color:#1a1d21;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:32px;max-width:440px;box-shadow:0 8px 30px rgba(16,24,40,.08)}
  h1{font-size:18px;margin:0 0 12px}
  p{font-size:14px;line-height:1.55;color:#41474f}
  code{background:#f1f3f5;padding:1px 5px;border-radius:4px;font-size:12.5px}
  form{display:flex;gap:10px;margin-top:20px}
  button{flex:1;padding:9px 0;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;border:1px solid transparent}
  .approve{background:#16181d;color:#fff}
  .deny{background:#fff;color:#41474f;border-color:#d6dade}
  a{color:#2563eb}
</style></head>
<body><div class="card"><h1>${esc(title)}</h1>${body}</div></body></html>`
}
