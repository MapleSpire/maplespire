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
 * T-DIAGDEF: the shutdown's `http` step, over REAL sockets:
 *
 *  - an SSE stream RELAYED from the owning cell (`proxyWorkspaceHttpRequest`)
 *    is ended by the LANDING cell's shutdown at once, not at its grace
 *    cut; once the shutdown began, a relayed stream is not opened;
 *  - ownership is never released while an HTTP handler runs: the step
 *    waits for the handlers (not the sockets) after the grace cut, and
 *    rejects — ownership retained — when one outlives its wait;
 *  - a stream refused during the shutdown opens and ends with a `retry:`
 *    (an EventSource reconnects), it is not a 503;
 *  - the route's cleanup runs before `res.end()`: nothing written after.
 */

import { once } from 'node:events'
import { Agent, createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import {
  closeHttpServer, endEventStreamForShutdown, HandlersStillRunningError, InFlightHandlers, LongLivedResponses,
} from './httpShutdown.js'
import { runGracefulShutdown } from './serverShutdown.js'
import { proxyWorkspaceHttpRequest } from './syncCells/httpProxy.js'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

function get(port: number, path: string, agent?: Agent): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent }, resolve)
    req.on('error', reject)
    req.end()
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The owning cell: an SSE stream that never ends (a heartbeat). */
async function ownerCell(): Promise<number> {
  const owner = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
    res.write('event: ready\ndata: {}\n\n')
    const beat = setInterval(() => res.write(': heartbeat\n\n'), 50)
    res.once('close', () => clearInterval(beat))
  })
  return listen(owner)
}

/** The landing cell: relays every request to the owner. */
async function landingCell(ownerPort: number, longLived?: LongLivedResponses): Promise<{ server: Server; port: number }> {
  const landing = createServer((req, res) => {
    void proxyWorkspaceHttpRequest({
      request: req,
      response: res,
      advertiseUrl: `http://127.0.0.1:${ownerPort}`,
      sourceCellId: 'landing-cell',
      ...(longLived ? { longLived } : {}),
    })
  })
  const port = await listen(landing)
  return { server: landing, port }
}

describe('the shutdown\'s http step — a relayed SSE stream', () => {
  it('is ended by the LANDING cell\'s shutdown at once: < 3 s, no connection cut', async () => {
    const longLived = new LongLivedResponses()
    const ownerPort = await ownerCell()
    const { server, port } = await landingCell(ownerPort, longLived)
    const stream = await get(port, '/api/model/cache/events', new Agent({ keepAlive: true }))
    expect(stream.headers['content-type']).toContain('text/event-stream')
    stream.resume()
    const ended = once(stream, 'end')
    await sleep(100)
    expect(longLived.size).toBe(1)

    const startedAt = performance.now()
    const outcome = await closeHttpServer(server, { longLived, log: () => undefined })

    expect(performance.now() - startedAt).toBeLessThan(3_000)
    expect(outcome.forcedConnections).toBe(false)
    expect(outcome.endedStreams).toBe(1)
    await ended
  })

  it('is not relayed once the shutdown began: it opens and ends with a retry', async () => {
    const longLived = new LongLivedResponses()
    const ownerPort = await ownerCell()
    const { port } = await landingCell(ownerPort, longLived)
    longLived.endAll()

    const response = await get(port, '/api/model/cache/events')
    let body = ''
    response.on('data', (chunk) => { body += String(chunk) })
    await once(response, 'end')

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(body).toBe('retry: 2000\n\n')
    expect(longLived.size).toBe(0)
  })
})

describe('the shutdown\'s http step — the refusal of a stream during the shutdown', () => {
  it('is a stream that opens and ends with `retry:`, never a 503', async () => {
    const port = await listen(createServer((_req, res) => endEventStreamForShutdown(res, 1_500)))
    const response = await get(port, '/events')
    let body = ''
    response.on('data', (chunk) => { body += String(chunk) })
    await once(response, 'end')
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(body).toBe('retry: 1500\n\n')
  })
})

describe('the shutdown\'s http step — the cleanup runs before the end', () => {
  it('no write after end: the heartbeat the cleanup stops never fires on an ended response', async () => {
    const longLived = new LongLivedResponses()
    const writesAfterEnd: string[] = []
    let cleanupSawEnded: boolean | null = null
    const port = await listen(createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const write = res.write.bind(res) as (chunk: string) => boolean
      res.write = ((chunk: string) => {
        if (res.writableEnded) writesAfterEnd.push(chunk)
        return write(chunk)
      }) as ServerResponse['write']
      // Writes on EVERY tick: a cleanup that ran after the end would leave
      // at least one heartbeat landing on an ended response.
      const beat = setInterval(() => res.write(': heartbeat\n\n'), 1)
      longLived.track(res, () => {
        cleanupSawEnded = res.writableEnded
        clearInterval(beat)
      })
    }))
    const stream = await get(port, '/events')
    stream.resume()
    await sleep(50)

    longLived.endAll()
    await sleep(50)

    expect(cleanupSawEnded).toBe(false)
    expect(writesAfterEnd).toEqual([])
  })
})

describe('the shutdown\'s http step — ownership is never released under a running handler', () => {
  /** A server whose `/write` handler runs `ms` (wrapped like `route()`), and
   * the shutdown sequence around it with an ordered log. */
  async function stackWithSlowWrite(ms: number) {
    const inFlight = new InFlightHandlers()
    const events: string[] = []
    const middleware = inFlight.middleware()
    const server = createServer((req, res) => middleware(req, res, () => {
      void inFlight.hold(req, (async () => {
        await sleep(ms)
        events.push('handler-done')
        if (!res.destroyed) res.end('ok')
      })())
    }))
    const port = await listen(server)
    return { inFlight, events, server, port }
  }

  function shutdown(server: Server, inFlight: InFlightHandlers, events: string[], options: { graceMs: number; handlerWaitMs: number }) {
    const { handlerWaitMs, ...closeOptions } = options
    const noop = () => Promise.resolve()
    const lines: string[] = []
    const done = runGracefulShutdown('SIGTERM', {
      stopIntake: () => undefined,
      stopStaticProjector: () => undefined,
      stopMaintenanceIntake: () => undefined,
      drainMaintenance: noop,
      closeDurableHeadsDecoder: noop,
      drainAutomerge: noop,
      stopChangeHub: noop,
      // The handler deadline is ABSOLUTE, from the signal.
      closeHttp: async (signalAt) => {
        await closeHttpServer(server, {
          inFlight, ...closeOptions, handlerDeadlineAt: signalAt + handlerWaitMs, log: (line) => lines.push(line),
        })
      },
      stopOwnership: async () => { events.push('ownership-released') },
      shutdownAutomerge: async () => { events.push('automerge-shutdown') },
      stopRedis: noop,
      endPools: async () => { events.push('pools-ended') },
      exit: (code) => { events.push(`exit ${code}`) },
      log: (line) => lines.push(line),
      forcedExitMs: 20_000,
    })
    return { done, lines }
  }

  it('a write running PAST the grace: ownership is released only after it ends (and its connection is kept)', async () => {
    const { inFlight, events, server, port } = await stackWithSlowWrite(1_000)
    const write = get(port, '/write').catch((error: Error) => error)
    await sleep(50)
    expect(inFlight.size).toBe(1)

    const { done, lines } = shutdown(server, inFlight, events, { graceMs: 200, handlerWaitMs: 5_000 })
    await done

    expect(lines.some((line) => line.includes('server.http_close_forced'))).toBe(true)
    // Its socket used to be cut at the grace; a held write now gets its answer.
    expect(((await write) as IncomingMessage).statusCode).toBe(200)
    expect(events).toEqual(['handler-done', 'ownership-released', 'automerge-shutdown', 'pools-ended', 'exit 0'])
  })

  it('a write running past its WAIT: the step rejects and ownership is RETAINED', async () => {
    const { inFlight, events, server, port } = await stackWithSlowWrite(3_000)
    void get(port, '/write').catch(() => undefined)
    await sleep(50)

    const { done, lines } = shutdown(server, inFlight, events, { graceMs: 100, handlerWaitMs: 300 })
    const failure = await done.then(() => null, (error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBeInstanceOf(HandlersStillRunningError)
    expect(events).not.toContain('ownership-released')
    expect(events).not.toContain('automerge-shutdown')
    expect(lines.some((line) => line.includes('"outcome":"failed"'))).toBe(true)
    expect(lines.some((line) => line.includes('server.http_handlers_still_running'))).toBe(true)
    await sleep(3_100)
  }, 10_000)

  it('a request NOT held (a read) is released when its socket closes — never leaked', async () => {
    // This case used to assert the OPPOSITE (counted until the response
    // ended, a closed socket notwithstanding) — it pinned the leak: a relayed
    // SSE the client dropped stayed in the set for the process's life.
    const inFlight = new InFlightHandlers()
    const middleware = inFlight.middleware()
    const port = await listen(createServer((req, res) => middleware(req, res, () => {
      // A read that never ends its response by itself.
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('partial')
    })))
    const client = get(port, '/plain')
    const response = await client
    response.resume()
    expect(inFlight.size).toBe(1)
    response.destroy()
    for (let i = 0; i < 50 && inFlight.size; i += 1) await sleep(10)
    expect(inFlight.size).toBe(0)
  })

  it('a HELD request stays counted past its socket\'s close, until its promise settles', async () => {
    const inFlight = new InFlightHandlers()
    const middleware = inFlight.middleware()
    let release: (() => void) | null = null
    const port = await listen(createServer((req, res) => middleware(req, res, () => {
      void inFlight.hold(req, new Promise<void>((resolve) => { release = () => { res.end('late'); resolve() } }))
    })))
    const client = get(port, '/write').catch(() => undefined)
    await sleep(50)
    for (const server of servers) server.closeAllConnections()
    await client
    await sleep(50)
    expect(inFlight.size).toBe(1)

    release!()
    await sleep(0)
    expect(inFlight.size).toBe(0)
  })
})
