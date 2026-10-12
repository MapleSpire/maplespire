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
 * The terminal error handler.
 *
 * Express 5 forwards a rejected handler promise to `next(err)` automatically.
 * Without a 4-arity handler, every unhandled rejection reaches `finalhandler`,
 * which answers with an HTML error page — including on the unauthenticated
 * login endpoint, and including during a Redis failover, when
 * `RedisUnavailableError` from the rate limiter is exactly the error a caller
 * most needs to parse.
 *
 * An API client receiving `<!DOCTYPE html>` where it expected JSON cannot tell a
 * retryable dependency outage from a permanent bug, so it retries neither
 * correctly nor safely.
 *
 * TWO THINGS ABOUT MOUNTING IT ARE NOT STYLISTIC:
 *
 * 1. It must be the LAST statement of `main()`, not registered beside the other
 *    `app.use` calls. Express dispatches an error forward from the index of the
 *    layer that threw, so a handler registered early is simply not in the path
 *    of any route added later — which here is org-seed, the AI feature, and the
 *    entire READ_MODEL block.
 * 2. It lives in its own module because `index.ts` builds pools, Express and the
 *    Automerge peer at import time, so a unit test cannot import it.
 */

import type { NextFunction, Request, Response } from 'express'
import { dependencyOutageResponse } from './dependencyOutageResponse.js'

export interface TerminalErrorHandlerOptions {
  /** Injected so a test can assert on the report without capturing stderr. */
  log?: (message: string, error: unknown) => void
}

/**
 * Build the 4-arity handler. The arity is load-bearing: Express identifies error
 * middleware by `fn.length === 4`, so dropping the unused `next` parameter would
 * silently register this as ordinary middleware that never runs on the error
 * path. `eslint` would otherwise flag it, hence the explicit use below.
 */
export function terminalErrorHandler(options: TerminalErrorHandlerOptions = {}) {
  const log = options.log ?? ((message, error) => console.error(message, error))

  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    // Delegating to the default handler is the documented behaviour once the
    // response has started: the status and part of the body are already on the
    // wire, so the only correct action left is to destroy the connection rather
    // than append a second payload to a half-sent one.
    if (res.headersSent) {
      next(err)
      return
    }

    // A transiently unavailable dependency. The mapping is NOT written here:
    // `route()` in `routeErrors.ts` needs the same answers and never forwards to
    // this handler, so a branch in each place would be two definitions of one
    // contract, and a client's answer would depend on which door it happened to
    // arrive at. `dependencyOutageResponse` is that contract; this handler keeps
    // only its own fallback below, which is the part that must differ.
    const outage = dependencyOutageResponse(err)
    if (outage) {
      log(`[express] ${req.method} ${req.path} — ${outage.subsystem} unavailable:`, err)
      res.status(outage.status)
      for (const [name, value] of Object.entries(outage.headers)) res.setHeader(name, value)
      res.json(outage.body)
      return
    }

    log(`[express] unhandled error on ${req.method} ${req.path}:`, err)
    // Deliberately no error text, stack, or `err.message` in the body: this
    // handler catches everything, including errors from unauthenticated
    // endpoints, and a message can carry a connection string or a SQL fragment.
    res.status(500).json({ error: 'internal_error' })
  }
}
