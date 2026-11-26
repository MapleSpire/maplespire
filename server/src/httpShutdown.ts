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

import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/**
 * THE `http` STEP OF THE GRACEFUL SHUTDOWN (T-DIAGDEF (4)).
 *
 * `server.close(cb)` only stops accepting: its callback fires once EVERY
 * connection has ended. Node 22 closes the connections that are idle at that
 * instant, nothing more. A response that never ends keeps its connection — and
 * `/api/model/cache/events` is exactly that, an SSE stream every open browser
 * holds for its whole session (a heartbeat every 25 s, no end). Measured with
 * one browser open on a workspace: the `http` step never ended, every later
 * step waited behind it, and the process left on the 30 s forced exit
 * (`server.shutdown_trace outcome=forced-exit`). Without a browser: ~110 ms.
 *
 * So this step:
 *  1. stops accepting (`server.close`);
 *  2. ENDS every registered long-lived response at once — the route's own
 *     cleanup first, so nothing writes after the end (the cell's SSE route,
 *     and the SSE it RELAYS from another cell, `syncCells/httpProxy.ts`); an
 *     EventSource reconnects by itself (to another replica, or to this one
 *     once it is back);
 *  3. closes keep-alive connections AS THEY BECOME IDLE (`closeIdleConnections`,
 *     polled): an in-flight request — a write — runs to its response, then its
 *     socket goes. Nothing is cut while it is being served;
 *  4. only past `graceMs` (a stuck or a slow client), cuts what is left —
 *     said in the log, never silent — EXCEPT a connection whose request a
 *     running handler holds: that one is kept until the handler deadline
 *     — cut, its write would succeed and its client see a failure and
 *     replay it;
 *  5. waits — FROM THE SIGNAL, in parallel with all of the above — for the
 *     HANDLERS ({@link InFlightHandlers}), not the sockets: a cut socket does
 *     not stop the handler that was serving it, and the sequence releases
 *     ownership and shuts the Repo down after this step. The wait has an
 *     ABSOLUTE deadline (`handlerDeadlineAt`, signal + 20 s in `index.ts`):
 *     it does not start after `server.close`'s callback, which also waits
 *     for the WebSockets the
 *     Automerge drain closes late. A handler still running at the deadline
 *     REJECTS the step: `runGracefulShutdown` then keeps ownership ("Server
 *     drain incomplete; ownership retained") and leaves on the forced exit.
 *     Ownership is never released while a handler runs.
 *
 * THE BUDGET (30 s forced exit, from the signal): grace cut at 10 s; handler
 * deadline at 20 s; then `runGracefulShutdown`'s late-write flush, bounded at
 * 4 s (24 s); ownership release, Repo shutdown, Redis and pools in what is
 * left — 6 s of real margin for steps that take milliseconds when healthy.
 *
 * Upgraded sockets (the Automerge WebSocket) are not HTTP connections any
 * more: the Automerge drain closes them (`closeAutomergeSockets`, 1012 then a
 * terminate at 5 s), and `server.close`'s callback waits for those too.
 */

/** Responses that never end on their own (SSE). A route registers its
 * response for as long as it is open. */
export class LongLivedResponses {
  private readonly open = new Map<ServerResponse, (() => void) | undefined>()
  private ended = false

  /** Returns the unregister function; call it from the route's cleanup.
   * `onEnd` is the route's own cleanup (timers, subscriptions, an upstream
   * pipe): {@link endAll} runs it BEFORE `res.end()`, so no `res.write` can
   * follow the end. */
  track(res: ServerResponse, onEnd?: () => void): () => void {
    this.open.set(res, onEnd)
    return () => { this.open.delete(res) }
  }

  get size(): number {
    return this.open.size
  }

  /** True once {@link endAll} ran: a stream whose request was accepted before
   * the shutdown but reaches its headers after it must not open (it would
   * hold its connection to the grace cut). */
  get closing(): boolean {
    return this.ended
  }

  /** End every registered response, each route's cleanup first. Returns how
   * many were open. */
  endAll(): number {
    this.ended = true
    const responses = [...this.open]
    this.open.clear()
    for (const [res, onEnd] of responses) {
      try {
        onEnd?.()
      } catch {
        // The end below still happens; a cleanup failure must not keep a
        // connection open.
      }
      try {
        if (!res.writableEnded) res.end()
      } catch {
        res.destroy()
      }
    }
    return responses.length
  }
}

/** The answer an SSE request gets once the streams are being ended: a stream
 * that opens and closes at once, telling the EventSource when to come back.
 * A 503 instead would CLOSE an EventSource for good (it reconnects only after
 * a stream that opened). */
export function endEventStreamForShutdown(res: ServerResponse, retryMs = 2_000): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end()
    return
  }
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.end(`retry: ${retryMs}\n\n`)
}

const IN_FLIGHT = Symbol('maplespire.inFlightHandler')

interface InFlightToken {
  method: string
  path: string
  startedAt: number
  /** Promises still holding the request (`hold`); while > 0 the response
   * events do not release it. */
  holds: number
  /** A response event (end, finish, close) happened while held: released
   * once the last hold settles. */
  responseSettled: boolean
  /** The connection serving it — the grace cut spares a held one. */
  socket: { destroy: () => void } | null
  end: () => void
}

/**
 * The HTTP handlers still RUNNING. Not the sockets: a
 * socket the grace cut destroyed leaves its handler running — and writing.
 *
 * A request is counted from the middleware (mounted first) until it SETTLES:
 *  - a HELD request ({@link hold}: every mutating registration of the app,
 *    `holdMutatingRoutes`; the `route()` wrapper; the cross-cell relay): when
 *    the LAST promise holding it settles, whatever its response or socket did
 *    — the handler stopped running then, not before;
 *  - any other (a read): when its response settles — ended, finished, or its
 *    socket CLOSED. Before that fix the close did not
 *    release it, so a relayed SSE the client dropped (a tab hidden) stayed in
 *    the set for the process's life: an unbounded leak, and every SIGTERM
 *    after it refused with `HandlersStillRunningError` and left on the forced
 *    exit holding its leases. A read writes nothing the ownership protects.
 */
export class InFlightHandlers {
  private readonly open = new Set<InFlightToken>()
  private waiters: Array<() => void> = []
  private sealedAt: number | null = null
  private refusedAfterSeal = 0

  get size(): number {
    return this.open.size
  }

  /** True once {@link seal} ran: no handler begins any more. */
  get sealed(): boolean {
    return this.sealedAt !== null
  }

  /** Handlers refused because they began after the seal. */
  get refused(): number {
    return this.refusedAfterSeal
  }

  /**
   * The census is CLOSED once the HTTP step has
   * resolved (`closeHttpServer` calls this). Until then a request whose client
   * went away while `requireAuth` awaited was released by that close and
   * counted again by its handler's hold — but a handler
   * that began AFTER the step resolved was counted by nobody any more: it
   * wrote after the late-write flush, after the lease was gone. Now such a
   * handler does not run: {@link refuseIfSealed} answers it 503, retryable.
   */
  seal(): void {
    this.sealedAt ??= performance.now()
  }

  /** Called where a handler BEGINS (`holding`, {@link holdHandler}): after
   * {@link seal}, answers 503 retryable — the work is not run — and returns
   * true. */
  refuseIfSealed(_req: unknown, res: unknown): boolean {
    if (this.sealedAt === null) return false
    this.refusedAfterSeal += 1
    const response = res as Partial<ServerResponse> | null
    if (response && typeof response.end === 'function' && !response.headersSent && !response.writableEnded) {
      response.statusCode = 503
      response.setHeader?.('Retry-After', '2')
      response.setHeader?.('Content-Type', 'application/json; charset=utf-8')
      response.end(JSON.stringify({ error: 'server shutting down', code: 'SHUTTING_DOWN', retryable: true }))
    }
    return true
  }

  /** Requests whose handler a promise still holds (a write in progress). */
  get heldCount(): number {
    let held = 0
    for (const token of this.open) if (token.holds > 0) held += 1
    return held
  }

  /** Cut the connections of the requests NOT held — a
   * read, a stuck client — and keep those a running handler is answering:
   * cut at the grace, a write that then succeeds is seen by its client as a
   * failure and replayed. */
  cutUnheld(): number {
    let cut = 0
    for (const token of [...this.open]) {
      if (token.holds > 0 || !token.socket) continue
      token.socket.destroy()
      cut += 1
    }
    return cut
  }

  /** What is still running, for the log of a refused shutdown. */
  describe(): string[] {
    const now = performance.now()
    return [...this.open].map((token) => `${token.method} ${token.path} (${Math.round(now - token.startedAt)} ms)`)
  }

  middleware(): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
    return (req, res, next) => {
      const token: InFlightToken = {
        method: req.method ?? 'GET',
        path: (req.url ?? '').split('?')[0],
        startedAt: performance.now(),
        holds: 0,
        responseSettled: false,
        socket: req.socket ?? null,
        end: () => {
          if (!this.open.delete(token)) return
          if (!this.open.size) for (const wake of this.waiters.splice(0)) wake()
        },
      }
      this.open.add(token)
      ;(req as unknown as Record<symbol, InFlightToken>)[IN_FLIGHT] = token
      const settleResponse = () => {
        token.responseSettled = true
        if (token.holds === 0) token.end()
      }
      const endResponse = res.end.bind(res) as (...args: unknown[]) => ServerResponse
      res.end = ((...args: unknown[]) => {
        settleResponse()
        return endResponse(...args)
      }) as ServerResponse['end']
      res.once('finish', settleResponse)
      res.once('close', settleResponse)
      next()
    }
  }

  /** Count `req` until `running` settles — and until every other hold of it
   * has (a relay held by the router, then a `route()` behind it). */
  hold<T>(req: unknown, running: Promise<T>): Promise<T> {
    const token = (req as Record<symbol, InFlightToken | undefined>)[IN_FLIGHT]
    if (!token) return running
    // A request whose socket CLOSED before its handler
    // began (a POST fully received, the client gone while `requireAuth`
    // awaited) was released by that close — its handler then wrote
    // uncounted. A hold puts it back: the handler runs, so it counts.
    if (!this.open.has(token)) this.open.add(token)
    token.holds += 1
    return running.finally(() => {
      token.holds -= 1
      if (token.holds === 0) token.end()
    })
  }

  /** Resolves `true` once nothing runs, `false` past `timeoutMs`. */
  idle(timeoutMs: number): Promise<boolean> {
    if (!this.open.size) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((wake) => wake !== done)
        resolve(false)
      }, timeoutMs)
      timer.unref()
      const done = () => { clearTimeout(timer); resolve(true) }
      this.waiters.push(done)
    })
  }
}

export const HELD_METHODS = ['post', 'put', 'patch', 'delete', 'all'] as const

type Registrar = (path: unknown, ...handlers: unknown[]) => unknown

/**
 * EVERY mutating registration of `app` holds its handler's promise:
 * `app.post|put|patch|delete|all` are wrapped once, before any
 * route is registered, so a handler that returns a promise — every async
 * handler, and `route()`'s — is counted until it settles, whichever module
 * registers it on this app. A handler that returns nothing (a synchronous one)
 * is counted by its response, as a read is. The coverage test
 * (`httpShutdown.coverage.test.ts`) fails if a mutating route escapes: one
 * registered on anything but this app, or on it before this call.
 */
export function holdMutatingRoutes<App extends object>(app: App, inFlight: InFlightHandlers): App {
  const target = app as unknown as Record<(typeof HELD_METHODS)[number], Registrar>
  for (const method of HELD_METHODS) {
    const register = target[method].bind(app)
    target[method] = (path: unknown, ...handlers: unknown[]) => register(path, ...handlers.map((handler) => (
      typeof handler === 'function' ? holding(handler as (...args: unknown[]) => unknown, inFlight) : handler
    )))
  }
  return app
}

function holding(handler: (...args: unknown[]) => unknown, inFlight: InFlightHandlers): (...args: unknown[]) => unknown {
  // The arity is express's signal (4 = an error handler): kept.
  // A handler that begins after the seal does not run.
  const wrapped = handler.length >= 4
    ? function (this: unknown, error: unknown, req: unknown, res: unknown, next: unknown) {
      if (inFlight.refuseIfSealed(req, res)) return undefined
      return held(handler.call(this, error, req, res, next), req, inFlight)
    }
    : function (this: unknown, req: unknown, res: unknown, next: unknown) {
      if (inFlight.refuseIfSealed(req, res)) return undefined
      return held(handler.call(this, req, res, next), req, inFlight)
    }
  return wrapped
}

/**
 * `index.ts`'s `route()` body: the handler's promise is
 * held — and a handler that begins after the seal is refused, 503, without
 * running. Here rather than inline so a test runs the real composition.
 */
export function holdHandler<Req, Res>(
  inFlight: InFlightHandlers,
  handler: (req: Req, res: Res) => Promise<void>,
): (req: Req, res: Res) => Promise<void> {
  return (req, res) => (inFlight.refuseIfSealed(req, res) ? Promise.resolve() : inFlight.hold(req, handler(req, res)))
}

function held(result: unknown, req: unknown, inFlight: InFlightHandlers): unknown {
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    return inFlight.hold(req, Promise.resolve(result as PromiseLike<unknown>))
  }
  return result
}

export class HandlersStillRunningError extends Error {
  constructor(readonly running: string[]) {
    super(`HTTP handlers still running after the shutdown's wait: ${running.join(', ')}`)
    this.name = 'HandlersStillRunningError'
  }
}

export interface CloseHttpServerOptions {
  longLived?: LongLivedResponses
  inFlight?: InFlightHandlers
  /** How often idle keep-alive connections are closed while draining. */
  idlePollMs?: number
  /** Past this, the remaining connections are cut. Well under the 30 s
   * forced exit of `runGracefulShutdown`. */
  graceMs?: number
  /** ABSOLUTE deadline (`performance.now()` clock) for the handlers to have
   * settled; past it the step rejects (ownership retained). Counted from the
   * SIGNAL by the caller (`runGracefulShutdown` passes its start), never from
   * `server.close`'s callback. Default: this call + 20 s. */
  handlerDeadlineAt?: number
  log?: (line: string) => void
}

export interface CloseHttpServerOutcome {
  endedStreams: number
  /** True when `graceMs` passed and the remaining connections were cut. */
  forcedConnections: boolean
  elapsedMs: number
}

export async function closeHttpServer(server: Server, options: CloseHttpServerOptions = {}): Promise<CloseHttpServerOutcome> {
  const startedAt = performance.now()
  const log = options.log ?? ((line: string) => console.log(line))
  const deadlineAt = options.handlerDeadlineAt ?? startedAt + 20_000
  let forcedConnections = false
  const closed = new Promise<CloseHttpServerOutcome>((resolve) => {
    let poll: NodeJS.Timeout | null = null
    let grace: NodeJS.Timeout | null = null
    let endedStreams = 0
    // Stop accepting FIRST, so a stream ended below cannot reconnect here. An
    // error in the callback (ERR_SERVER_NOT_RUNNING) still means "no
    // connection is left to wait for".
    server.close(() => {
      if (poll) clearInterval(poll)
      if (grace) clearTimeout(grace)
      resolve({ endedStreams, forcedConnections, elapsedMs: Math.round(performance.now() - startedAt) })
    })
    endedStreams = options.longLived?.endAll() ?? 0
    // POLLED, not once: `closeIdleConnections` closes
    // only what is idle AT THAT INSTANT. A connection whose response ends a
    // moment later (a write finishing, a stream just ended above whose
    // `finish` has not been processed yet) is busy now and idle in a tick; a
    // single call races it and leaves it open to the grace cut. The race the
    // other way is harmless: a request that arrives on a connection between
    // two polls is served (the connection is busy, so it is not closed), and
    // the poll after its response takes the connection.
    server.closeIdleConnections()
    poll = setInterval(() => server.closeIdleConnections(), options.idlePollMs ?? 50)
    poll.unref()
    grace = setTimeout(() => {
      forcedConnections = true
      // A connection whose request a running handler
      // holds is spared until the handler DEADLINE — cut here, its write
      // would succeed and its client see a failure (and replay it). Everything
      // else goes now. With no held request, the old cut: every connection.
      const held = options.inFlight?.heldCount ?? 0
      if (held > 0) {
        const cut = options.inFlight!.cutUnheld()
        server.closeIdleConnections()
        log(JSON.stringify({
          event: 'server.http_close_forced',
          graceMs: options.graceMs ?? 10_000,
          note: 'connections without a running handler were closed; those with one are kept until the handler deadline',
          cut,
          kept: held,
        }))
        const atDeadline = setTimeout(() => server.closeAllConnections(), Math.max(0, deadlineAt - performance.now()))
        atDeadline.unref()
        return
      }
      log(JSON.stringify({
        event: 'server.http_close_forced',
        graceMs: options.graceMs ?? 10_000,
        note: 'connections still active past the grace period were closed',
      }))
      server.closeAllConnections()
    }, options.graceMs ?? 10_000)
    grace.unref()
  })
  const refuse = (): never => {
    options.inFlight!.seal()
    const running = options.inFlight!.describe()
    log(JSON.stringify({ event: 'server.http_handlers_still_running', forcedConnections, running }))
    throw new HandlersStillRunningError(running)
  }
  if (!options.inFlight) return closed
  // The handlers are awaited IN PARALLEL with the sockets, against the
  // absolute deadline: a handler still running then rejects at once, even if
  // `server.close` is itself still waiting (a WebSocket the Automerge drain
  // terminates late). Once the sockets are gone the census is read again: a
  // request that arrived on a kept-alive connection between two polls was
  // still served, and is waited for, within the same deadline.
  const first = await Promise.race([
    closed.then(() => 'closed' as const),
    options.inFlight.idle(Math.max(0, deadlineAt - performance.now())).then((idle) => (idle ? 'idle' as const : 'late' as const)),
  ])
  if (first === 'late') refuse()
  const outcome = await closed
  if (!(await options.inFlight.idle(Math.max(0, deadlineAt - performance.now())))) refuse()
  // SEALED as the step resolves — a handler that begins
  // from now on (its `requireAuth` was still awaiting) is refused, 503. Read
  // once more after the seal: a hold taken in the microtasks between the
  // census going idle and this line is waited for, within the same deadline;
  // past the seal none can be taken.
  options.inFlight.seal()
  if (!(await options.inFlight.idle(Math.max(0, deadlineAt - performance.now())))) refuse()
  return { ...outcome, elapsedMs: Math.round(performance.now() - startedAt) }
}
