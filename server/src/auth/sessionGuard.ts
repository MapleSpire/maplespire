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

import type { Request, Response } from 'express'

/**
 * Per-route session guard for handlers that need a signed-in caller.
 * Returns the verified claims, or answers 401 `{ error }` and returns null
 * so the handler can `if (!auth) return`.
 *
 * `req.auth` is set only by the global auth middleware (a verified cookie)
 * or the bearer-token bridge, never from request data.
 */
export function requireSessionAuth(
  req: Request,
  res: Response,
  error = 'Authentication required',
): NonNullable<Request['auth']> | null {
  const auth = req.auth
  if (!auth) {
    res.status(401).json({ error })
    return null
  }
  return auth
}
