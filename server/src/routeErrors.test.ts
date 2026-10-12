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
 * The read-model error mapping and the `route()` wrapper that applies it.
 *
 * What each arm defends is the answer to "whose problem is it, and should the
 * caller retry?". Getting that wrong does not break a page; it makes an
 * operator stop retrying something that would have worked, which is the kind of
 * defect that never produces a bug report.
 */
import { describe, expect, it } from 'vitest'
import { route, routeErrorResponse } from './routeErrors.js'
import { LifecycleApplyRefusedError } from './maintenance/lifecycleApplyLock.js'
import { ReadModelCursorError } from './readModel/cursor.js'
import {
  DocumentPermanentlyUnavailableError,
  DocumentTemporarilyUnavailableError,
} from './readModel/documentResolution.js'
import { StaleSyncCellWriteError } from './automergeStorageErrors.js'
import { RedisUnavailableError } from './runtime/redis.js'
import { dependencyOutageResponse } from './runtime/dependencyOutageResponse.js'

describe('routeErrorResponse', () => {
  it('answers 400 for a malformed cursor — the request is wrong, not the server', () => {
    expect(routeErrorResponse(new ReadModelCursorError('bad'))).toEqual({
      status: 400, body: { error: 'invalid cursor' },
    })
  })

  it('answers 503 + retryable for a document that has not arrived yet', () => {
    expect(routeErrorResponse(new DocumentTemporarilyUnavailableError('automerge:x'))).toEqual({
      status: 503,
      headers: { 'Retry-After': '2' },
      body: { error: 'document not available yet', retryable: true },
    })
  })

  it('answers 404, NOT 500, for a document that is permanently gone', () => {
    // A 500 here invites a pointless retry.
    expect(routeErrorResponse(new DocumentPermanentlyUnavailableError('automerge:x'))).toEqual({
      status: 404, body: { error: 'document no longer exists' },
    })
  })

  describe('a refused lifecycle apply', () => {
    // Each expectation below pins one part of the contract, so replacing the
    // branch with the generic 500 fails several of them.
    const refusal = new LifecycleApplyRefusedError('lock-unavailable', 'another door holds the apply lock')

    it('is 503 and NOT 500 — nothing was written, and coming back fixes it', () => {
      expect(routeErrorResponse(refusal).status).toBe(503)
    })

    it('carries `retryable` and a Retry-After, so a client knows to come back', () => {
      const response = routeErrorResponse(refusal)
      expect(response.body.retryable).toBe(true)
      expect(response.headers?.['Retry-After']).toBe('5')
    })

    it('passes the MESSAGE through — the operator cannot act on "read model query failed"', () => {
      expect(routeErrorResponse(refusal).body.error).toBe('another door holds the apply lock')
    })

    it('carries the machine-readable code, distinctly per refusal reason', () => {
      expect(routeErrorResponse(refusal).body.code).toBe('lock-unavailable')
      expect(routeErrorResponse(new LifecycleApplyRefusedError('workspace-moved', 'it moved')).body.code)
        .toBe('workspace-moved')
    })

    it('gives the two new transient reasons the SAME 503 contract', () => {
      // `pool-exhausted`: `db.connect()` timing out raises an ordinary Error,
      // and it is answered by coming back exactly like a held lock is.
      // `exclusion-unproven` is the writing session failing to prove it holds
      // the key: nothing was written, and a fresh session is the fix.
      for (const code of ['pool-exhausted', 'exclusion-unproven'] as const) {
        const response = routeErrorResponse(new LifecycleApplyRefusedError(code, `${code} happened`))
        expect({ code, ...response }).toEqual({
          code,
          status: 503,
          headers: { 'Retry-After': '5' },
          body: { error: `${code} happened`, code, retryable: true },
        })
      }
    })

    it('keeps EVERY code on the transient contract — the union has no 400 member', async () => {
      // Walks every code in the union, so a new non-transient member (one the
      // identical request would hit again) fails here rather than being
      // quietly served a 503 that tells a client to retry something that
      // cannot succeed. An oversized apply, for example, takes a bounded slice
      // and reports `truncated` instead of refusing.
      const codes = ['lock-unavailable', 'workspace-moved', 'pool-exhausted', 'exclusion-unproven'] as const
      for (const code of codes) {
        const response = routeErrorResponse(new LifecycleApplyRefusedError(code, `${code} happened`))
        expect({ code, ...response }).toEqual({
          code,
          status: 503,
          headers: { 'Retry-After': '5' },
          body: { error: `${code} happened`, code, retryable: true },
        })
      }
    })
  })

  describe('a transient dependency outage', () => {
    // Sync-cell fence refusals (`StaleSyncCellWriteError`) do reach `route()`.
    // The generic `500 {"error":"read model query failed"}` would be
    // permanent-sounding for a transient condition, and would blame a
    // subsystem that had not failed.
    const refusal = new StaleSyncCellWriteError('snapshot', 'ownership-unavailable')

    it('is 503, and no longer the generic 500 a fence refusal used to get', () => {
      expect(routeErrorResponse(refusal).status).toBe(503)
      expect(routeErrorResponse(refusal).body.error).not.toBe('read model query failed')
    })

    it('carries the SHARED mapping through rather than a second copy of it', () => {
      // The invariant: one definition, two doors. Re-inlining
      // a branch here — the easy way to "fix" a divergence — fails this arm, and
      // so does letting the two doors drift apart. The literals themselves are
      // pinned once, in `runtime/dependencyOutageResponse.test.ts`; asserting
      // them again here would be the duplication in the tests instead.
      const shared = dependencyOutageResponse(refusal)!
      expect(routeErrorResponse(refusal)).toEqual({
        status: shared.status, headers: shared.headers, body: shared.body,
      })
    })

    it('answers a Redis outage with the same contract the terminal handler does', () => {
      const shared = dependencyOutageResponse(new RedisUnavailableError())!
      expect(routeErrorResponse(new RedisUnavailableError())).toEqual({
        status: shared.status, headers: shared.headers, body: shared.body,
      })
    })

    it('does NOT tell a client the refused write is safe to repeat', () => {
      // Pinned at this door as well as at the mapping, because this is where a
      // 503 for a write actually reaches a caller. An interrupted mutating
      // request can leave durable documents behind, and the rollback meant to
      // undo them cannot run during this outage.
      expect(routeErrorResponse(refusal).body).not.toHaveProperty('retryable')
    })

    it('does not leak the log-only `subsystem` FIELD into the response', () => {
      // It exists so the log line and the body cannot name different
      // subsystems; a client has no use for the field itself.
      //
      // Asserted as an ABSENT KEY, not an absent substring: the body names the
      // subsystem in prose (`sync-cell ownership cannot be established`), and a
      // wrapper that spread the whole mapping into the response fails this.
      const response = routeErrorResponse(refusal)
      expect(response).not.toHaveProperty('subsystem')
      expect(response.body).not.toHaveProperty('subsystem')
    })
  })

  it('falls back to an OPAQUE 500 for anything else', () => {
    // The default must stay opaque: every branch above passes detail out
    // deliberately, and an unrecognised error has not been reasoned about.
    for (const err of [new Error('boom with a stack trace and a connection string'), 'a string', null, undefined]) {
      expect(routeErrorResponse(err)).toEqual({ status: 500, body: { error: 'read model query failed' } })
    }
  })

  it('does not leak an unrecognised error message', () => {
    const secret = 'postgres://user:password@host/db'
    expect(JSON.stringify(routeErrorResponse(new Error(secret)))).not.toContain(secret)
  })
})

/**
 * THE WIRING between `route()` and `routeErrorResponse`.
 *
 * Lint cannot see any of what follows: a `route` that computed the response and
 * then answered 500 anyway, or set the status without the headers, or wrote
 * onto a response already streamed, keeps every import used.
 */
describe('route — the wrapper that applies the mapping', () => {
  interface Recorded { status?: number; body?: unknown; headers: Record<string, string> }

  /**
   * `destroys` is counted OUTSIDE `recorded` on purpose, so the arms asserting
   * `toEqual({ headers: {} })` — an exact compare on "the wrapper wrote
   * nothing" — can stay exact rather than loosening to `toMatchObject`.
   */
  const fakeRes = (headersSent = false, writableEnded = false) => {
    const recorded: Recorded = { headers: {} }
    const destroys = { count: 0 }
    const res = {
      headersSent,
      writableEnded,
      setHeader: (name: string, value: string) => { recorded.headers[name] = value },
      status: (code: number) => {
        recorded.status = code
        return { json: (body: unknown) => { recorded.body = body } }
      },
      destroy: () => { destroys.count += 1 },
    }
    return { res, recorded, destroys }
  }

  /** Swallow the wrapper's own console.error so a passing run stays readable. */
  const silent = () => undefined

  it('applies the STATUS, the HEADERS and the BODY the mapping chose', async () => {
    const { res, recorded, destroys } = fakeRes()
    const handler = route<unknown, typeof res>(
      async () => { throw new LifecycleApplyRefusedError('lock-unavailable', 'a neighbour holds it') },
      silent,
    )
    handler({}, res)
    await new Promise((resolve) => setImmediate(resolve))

    // AND IT DOES NOT DESTROY THE CONNECTION: a destroy after
    // `res.status(status).json(body)` would abort the socket on every error
    // response and kill keep-alive for a request answered correctly. The
    // destroy belongs to the `headersSent` branch alone.
    expect(destroys.count).toBe(0)

    // All three together: a wrapper that drops the headers, or answers a
    // hard-coded status, or JSONs something other than `body`, fails here and
    // passes every arm above.
    expect(recorded).toEqual({
      status: 503,
      headers: { 'Retry-After': '5' },
      body: { error: 'a neighbour holds it', code: 'lock-unavailable', retryable: true },
    })
  })

  it('carries a DIFFERENT mapping through unchanged — it is not answering 503 by accident', async () => {
    const { res, recorded } = fakeRes()
    route<unknown, typeof res>(async () => { throw new ReadModelCursorError('bad') }, silent)({}, res)
    await new Promise((resolve) => setImmediate(resolve))
    expect(recorded).toEqual({ status: 400, headers: {}, body: { error: 'invalid cursor' } })
  })

  it('carries a fence refusal to the client — status, Retry-After AND body', async () => {
    // The wiring for the dependency-outage branch, driven the same way as the
    // one above: a wrapper that computed the 503 and then answered 500 anyway, or
    // dropped the `Retry-After`, passes every mapping arm and fails here.
    const { res, recorded } = fakeRes()
    const refusal = new StaleSyncCellWriteError('snapshot', 'fence-mismatch')
    route<unknown, typeof res>(async () => { throw refusal }, silent)({}, res)
    await new Promise((resolve) => setImmediate(resolve))

    const shared = dependencyOutageResponse(refusal)!
    expect(recorded).toEqual({ status: shared.status, headers: shared.headers, body: shared.body })
    // Named explicitly, because "equals the shared mapping" would still hold if
    // the shared mapping stopped asking the client to come back at all.
    expect(recorded.headers['Retry-After']).toBe('15')
    expect(recorded.status).toBe(503)
  })

  it('names the failed subsystem in the LOG, not only in the body', async () => {
    // The log line is what an operator reads first. A body that says
    // `sync-cell ownership` under a log line that still says
    // `[read-model API] error:` sends them to the wrong place.
    const seen: unknown[] = []
    const { res } = fakeRes()
    const refusal = new StaleSyncCellWriteError('snapshot', 'ownership-unavailable')
    route<unknown, typeof res>(
      async () => { throw refusal },
      (message, error) => seen.push(message, error),
    )({}, res)
    await new Promise((resolve) => setImmediate(resolve))

    expect(seen[0]).toContain('sync-cell ownership')
    expect(seen[0]).not.toBe('[read-model API] error:')
    expect(seen[1]).toBe(refusal)
  })

  it('writes NOTHING onto a response whose headers already went out', async () => {
    // A handler that streamed part of a response and then failed. Writing a
    // status onto it throws a second error inside the first one's handler and
    // loses both — which is the failure this branch exists to prevent, and it
    // is invisible to every assertion about the mapping.
    const { res, recorded, destroys } = fakeRes(true)
    route<unknown, typeof res>(async () => { throw new Error('failed mid-stream') }, silent)({}, res)
    await new Promise((resolve) => setImmediate(resolve))
    expect(recorded).toEqual({ headers: {} })
    // AND THE CONNECTION IS DESTROYED. Returning silently would leave a
    // half-written response never terminated, so under keep-alive the client
    // waits out its own timeout. The terminal handler destroys via
    // finalhandler; this door must match.
    expect(destroys.count).toBe(1)
  })

  it('does NOT destroy a response that already ENDED and then rejected', async () => {
    // THE ARM WITHOUT WHICH THE ONE ABOVE PROVES NOTHING. `headersSent` is
    // true in two states, and only
    // one of them is a half-written response: a handler can answer correctly,
    // `end()` the response, and have its promise reject afterwards. Destroying
    // there discards whatever is still in the write queue — and `compression()`
    // is mounted on this app, so the zlib transform flushes on a LATER TICK,
    // which makes the window real rather than theoretical.
    //
    // Fixing a hang by truncating correct responses would be a worse defect than
    // the hang. `writableEnded` is what separates them (the same guard
    // `syncCells/httpProxy.ts` carries).
    const { res, recorded, destroys } = fakeRes(true, true)
    route<unknown, typeof res>(async () => { throw new Error('rejected AFTER answering') }, silent)({}, res)
    await new Promise((resolve) => setImmediate(resolve))
    expect(recorded).toEqual({ headers: {} })
    expect(destroys.count).toBe(0)
  })

  it('leaves a SUCCESSFUL handler entirely alone', async () => {
    const { res, recorded, destroys } = fakeRes()
    let ran = false
    route<unknown, typeof res>(async () => { ran = true }, silent)({}, res)
    await new Promise((resolve) => setImmediate(resolve))
    expect(ran).toBe(true)
    expect(recorded).toEqual({ headers: {} })
    // The destroy is for the ERROR path with headers already sent, nothing
    // else. A wrapper that destroyed a healthy response would be a far worse
    // defect than the one it fixes — and this arm is the only thing separating
    // the two.
    expect(destroys.count).toBe(0)
  })

  it('LOGS the error as well as answering it', async () => {
    // The log is the only record of the opaque 500s: the body deliberately says
    // nothing, so a wrapper that stopped logging would make every unrecognised
    // failure undiagnosable while every arm above stayed green.
    const seen: unknown[] = []
    const { res } = fakeRes()
    const boom = new Error('boom')
    route<unknown, typeof res>(async () => { throw boom }, (message, error) => seen.push(message, error))({}, res)
    await new Promise((resolve) => setImmediate(resolve))
    expect(seen).toEqual(['[read-model API] error:', boom])
  })
})
