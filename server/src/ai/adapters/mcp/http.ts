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

import type { Express, Request, Response } from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { pool } from '../../../db.js'
import { authStage } from '../../../auth/middleware.js'
import { verifyBearerIdentity, type AiIdentity } from '../../core/identity.js'
import { buildMcpServer, type McpDeps } from './buildServer.js'
import { requestPublicBaseUrl } from '../publicBaseUrl.js'

/**
 * Remote MCP server — Streamable HTTP at `/mcp`, STATELESS mode: one
 * McpServer + transport per request, no session ids. Auth is a Bearer token
 * (`bvr_` PAT or an OAuth-minted token) verified on EVERY request; 401s carry
 * the RFC 9728 `WWW-Authenticate` pointer at our protected-resource metadata
 * so OAuth-capable hosts (Claude Code, claude.ai…) auto-discover the flow
 * (adapters/mcp/oauth.ts).
 *
 * Auth staging: when the platform runs AUTH=off (open local dev), an
 * UNAUTHENTICATED /mcp call is allowed — byte-consistent with every other
 * API surface at that stage. A presented-but-invalid token is still 401'd.
 */

function unauthorized(req: Request, res: Response, detail: string): void {
  res
    .status(401)
    .setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${requestPublicBaseUrl(req)}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="${detail}"`
    )
  res.json({ error: 'unauthorized', detail })
}

export function registerMcpHttpRoutes(app: Express, deps: McpDeps): void {
  // RFC 9728 protected-resource metadata (both the bare and /mcp-suffixed
  // paths — clients derive either from the resource URL).
  const prMetadata = (req: Request, res: Response) => {
    res.json({
      resource: `${requestPublicBaseUrl(req)}/mcp`,
      authorization_servers: [requestPublicBaseUrl(req)],
      bearer_methods_supported: ['header'],
      scopes_supported: ['mcp'],
    })
  }
  app.get('/.well-known/oauth-protected-resource', prMetadata)
  app.get('/.well-known/oauth-protected-resource/mcp', prMetadata)

  app.all('/mcp', (req, res) => {
    void handleMcp(req, res, deps).catch((err) => {
      console.error('[mcp] request failed:', err)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal server error' },
          id: null,
        })
      }
    })
  })
}

async function handleMcp(req: Request, res: Response, deps: McpDeps): Promise<void> {
  const header = req.headers.authorization
  let identity: AiIdentity | null = null
  if (header?.startsWith('Bearer ')) {
    identity = await verifyBearerIdentity(pool, header.slice('Bearer '.length).trim())
    if (!identity) {
      unauthorized(req, res, 'invalid or revoked token')
      return
    }
  } else if (authStage() !== 'off') {
    unauthorized(req, res, 'missing bearer token')
    return
  }

  const server = buildMcpServer(deps, identity)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session tracking
    enableJsonResponse: true,
  })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  // The SDK reads `req.auth` as ITS AuthInfo (our express augmentation types
  // the same property as SessionClaims — hence the cast). Populate it so
  // handler `extra.authInfo` is truthful for any future tool that wants it.
  const sdkReq = req as unknown as import('node:http').IncomingMessage & {
    auth?: { token: string; clientId: string; scopes: string[] }
  }
  sdkReq.auth = identity
    ? { token: 'verified', clientId: identity.tokenId ?? identity.userId, scopes: identity.scopes }
    : undefined
  await transport.handleRequest(sdkReq, res, req.body)
}
