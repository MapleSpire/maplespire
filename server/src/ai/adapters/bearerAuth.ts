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

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { pool } from '../../db.js'
import { TOKEN_PREFIX } from '../core/tokens.js'
import { identityToClaims, verifyBearerIdentity } from '../core/identity.js'
import type { AiIdentity } from '../core/identity.js'

/**
 * Bearer→session bridge for `/api`: a valid `Authorization: Bearer bvr_…`
 * token authenticates the request AS ITS OWNING USER by setting `req.auth`
 * before `requireAuth` runs (which passes through when `req.auth` is already
 * set). Lets MCP hosts, scripts and the local stdio adapter call the tool
 * REST API with the same RBAC identity as a browser session.
 *
 * Non-`bvr_` Authorization headers are ignored (not our scheme); an INVALID
 * `bvr_` token is also passed through unauthenticated — `requireAuth` then
 * 401s at stage 'on', exactly like a bad cookie.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set when `req.auth` came from an AI bearer token (adapters can log/scope by it). */
      aiIdentity?: AiIdentity
    }
  }
}

export function aiBearerBridge(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ') || req.auth) {
      next()
      return
    }
    const token = header.slice('Bearer '.length).trim()
    if (!token.startsWith(TOKEN_PREFIX)) {
      next()
      return
    }
    verifyBearerIdentity(pool, token)
      .then((identity) => {
        if (identity) {
          req.auth = identityToClaims(identity)
          req.aiIdentity = identity
        }
        next()
      })
      .catch((err) => {
        console.error('[ai] bearer verification error:', err)
        next()
      })
  }
}
