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
 * How a thrown error becomes an HTTP response for the read-model API.
 *
 * A separate module (not inline in `index.ts`, which boots a server on import)
 * so the mapping and its wiring can be unit-tested: the distinction between
 * "transient, come back" and "server fault" is the entire contract here.
 *
 * Every branch answers one question: WHOSE PROBLEM IS IT, and should the
 * caller retry? A 500 says "a fault you cannot act on"; each specific branch
 * exists because that answer is wrong for the case it handles.
 */

import { LifecycleApplyRefusedError } from './maintenance/lifecycleApplyLock.js'
import {
  DocumentPermanentlyUnavailableError,
  DocumentTemporarilyUnavailableError,
} from './readModel/documentResolution.js'
import { ReadModelCursorError } from './readModel/cursor.js'
import { dependencyOutageResponse } from './runtime/dependencyOutageResponse.js'

export interface RouteErrorResponse {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
}

export function routeErrorResponse(err: unknown): RouteErrorResponse {
  if (err instanceof ReadModelCursorError) {
    return { status: 400, body: { error: 'invalid cursor' } }
  }
  if (err instanceof DocumentTemporarilyUnavailableError) {
    // A document that has not reached this server yet is a transient condition,
    // not a server fault: tell the client to come back rather than reporting a
    // failure it cannot act on.
    return {
      status: 503,
      headers: { 'Retry-After': '2' },
      body: { error: 'document not available yet', retryable: true },
    }
  }
  if (err instanceof DocumentPermanentlyUnavailableError) {
    // The counterpart, and it must NOT be a 500: a deleted document or a
    // malformed reference is a statement about the request, not a fault the
    // server can fix, and a 500 invites a pointless retry. Reachable when
    // `resolveHandleWithRetry` reports a non-ready handle as permanently
    // unavailable.
    return { status: 404, body: { error: 'document no longer exists' } }
  }
  if (err instanceof LifecycleApplyRefusedError) {
    // A mutating lifecycle door that refused BEFORE writing anything — either a
    // neighbour holds the workspace's apply lock, or the workspace moved while
    // this run was gathering its evidence. Both are transient and both are
    // fixed by coming back, so a 500 would be a lie about who has to act.
    //
    // The message is passed through, unlike the generic branch below, because
    // it names WHICH neighbour condition refused and the operator cannot act
    // without that. What bounds the exposure is the set of THROW SITES, not
    // this branch: `route()` wraps every read-model handler, so nothing
    // structurally confines this to a platform-admin path. The only code that
    // throws it is `repairReferenceIntegrity`, on a platform-admin route,
    // and its messages carry workspace ids and root document URLs. A second
    // thrower on a user-facing route would need this re-examined.
    return {
      status: 503,
      headers: { 'Retry-After': '5' },
      body: { error: err.message, code: err.code, retryable: true },
    }
  }
  // A dependency this server needs is transiently down. The mapping is shared
  // with `terminalErrorHandler` rather than repeated here — see
  // `runtime/dependencyOutageResponse.ts` for why there are two doors at all,
  // and for what it deliberately leaves as a 500.
  //
  // This is LAST among the specific branches on purpose: every branch above
  // names an error this module owns, and none of them can also be a dependency
  // outage, so the order is documentation rather than precedence. What it must
  // stay ahead of is the generic 500 fallback below.
  const outage = dependencyOutageResponse(err)
  if (outage) return { status: outage.status, headers: outage.headers, body: outage.body }

  return { status: 500, body: { error: 'read model query failed' } }
}

/** The five members this wrapper actually uses — see `route` below. */
export interface RouteResponseLike {
  headersSent: boolean
  setHeader(name: string, value: string): unknown
  status(code: number): { json(body: unknown): unknown }
  /**
   * Optional so a test can still hand this three members and so a non-socket
   * response object stays usable. `http.ServerResponse` always has both; see the
   * `headersSent` branch in `route` for why they are read.
   */
  destroy?: (error?: Error) => unknown
  writableEnded?: boolean
}

/**
 * Wrap an async handler so a rejection becomes the response `routeErrorResponse`
 * chose.
 *
 * Lives here rather than in `index.ts` (which boots a server on import) so the
 * WIRING, not just the mapping, is testable.
 *
 * The parameter is structural rather than `express.Response` on purpose: the
 * members of `RouteResponseLike` are all the wrapper touches, so a test can
 * hand it a plain object and assert the status, the headers AND the body that
 * actually reach a client.
 *
 * `headersSent` is checked because a handler may have streamed part of a
 * response before failing; writing a status onto it would throw a second error
 * inside the first one's handler and lose both.
 */
export function route<Req, Res extends RouteResponseLike>(
  handler: (req: Req, res: Res) => Promise<unknown>,
  log: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
): (req: Req, res: Res) => void {
  return (req, res) => {
    handler(req, res).catch((err: unknown) => {
      // The log names the failed subsystem too, not just the body: the log line
      // is what an operator reads first, and a generic `read-model API` line
      // over a `sync-cell ownership` body sends them to the wrong place.
      //
      // The mapping is consulted twice per failure — here and inside
      // `routeErrorResponse` below. It is a pure function over an error object;
      // threading the result through would buy nothing and would make the
      // mapping's single entry point conditional on the caller.
      const outage = dependencyOutageResponse(err)
      log(outage ? `[read-model API] ${outage.subsystem} unavailable:` : '[read-model API] error:', err)
      if (res.headersSent) {
        // DESTROY, not `return`, matching `terminalErrorHandler` (whose
        // `finalhandler` destroys the connection). Returning silently would
        // leave a half-written response never terminated, and under keep-alive
        // the client waits out its own timeout. Once the status is on the wire
        // there is no in-band way to signal failure; an aborted connection is
        // surfaced by every HTTP client as an error rather than a hang.
        //
        // BUT ONLY IF IT HAS NOT ALREADY ENDED — otherwise a fix for a hang
        // becomes a truncation.
        // `headersSent` is true in TWO states: started-and-abandoned, which this
        // branch is for, and COMPLETED-then-rejected — a handler that answered
        // correctly and whose promise settled with an error afterwards.
        // `OutgoingMessage.destroy()` discards whatever is still in the write
        // queue, and `compression()` is mounted on this app, so the zlib
        // transform flushes on a later tick: "res.end() returned" is a long way
        // from "the bytes are on the wire". Without this guard a correct
        // response gets truncated. `syncCells/httpProxy.ts` already carries the
        // same guard for the same reason; this is that idiom, not a new one.
        //
        // Both members are optional-chained because `RouteResponseLike` is
        // structural: an `http.ServerResponse` always has them, a test double
        // need not — and `writableEnded === undefined` reads as "not ended",
        // which is the safe default for a double that does not model it.
        if (!res.writableEnded) res.destroy?.()
        return
      }
      const { status, body, headers } = routeErrorResponse(err)
      for (const [name, value] of Object.entries(headers ?? {})) res.setHeader(name, value)
      res.status(status).json(body)
    })
  }
}

/**
 * Re-exported so `index.ts` can reach it through its existing import of this
 * module: this is where "how a thrown error becomes an HTTP response" lives for
 * this server, and the handlers that need it are HTTP handlers.
 */
export { sendDependencyOutage } from './runtime/dependencyOutageResponse.js'
