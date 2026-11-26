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
 * T-DIAGDEF: the shutdown's handler census and late writes, over real sockets:
 *
 *  - the handler census never leaks: a landing cell WITH the census, a
 *    relayed SSE its client closes, then SIGTERM → `complete`, the set
 *    empty; an abandoned relayed read or write is released; a relayed
 *    write IN FLIGHT stays counted until the owner answers; every
 *    mutating registration of an express app holds its handler's promise
 *    (`holdMutatingRoutes`);
 *  - the write a handler makes after the Automerge drain's flush is
 *    flushed BEFORE ownership is released (or ownership is kept); the
 *    handler deadline is ABSOLUTE, from the signal.
 */

import { once } from 'node:events'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'

import { closeHttpServer, holdMutatingRoutes, InFlightHandlers, LongLivedResponses } from './httpShutdown.js'
import { LateWriteFlushTimeoutError, runGracefulShutdown, type GracefulShutdownResources } from './serverShutdown.js'
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

function send(port: number, path: string, method = 'GET'): { response: Promise<IncomingMessage>; abort: () => void } {
  let abort = () => {}
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, resolve)
    req.on('error', reject)
    abort = () => req.destroy()
    req.end()
  })
  return { response, abort }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (predicate: () => boolean, ms = 2_000) => {
  const by = Date.now() + ms
  while (!predicate() && Date.now() < by) await sleep(10)
}

/** The owning cell: an SSE that never ends, a slow read, a slow write. */
async function ownerCell(writes: string[]): Promise<number> {
  return listen(createServer((req, res) => {
    if (req.url?.startsWith('/api/model/cache/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      res.write('event: ready\ndata: {}\n\n')
      const beat = setInterval(() => res.write(': heartbeat\n\n'), 50)
      res.once('close', () => clearInterval(beat))
      return
    }
    const ms = req.method === 'POST' ? 500 : 400
    setTimeout(() => {
      if (req.method === 'POST') writes.push('owner-applied')
      if (!res.destroyed) res.end('{"ok":true}')
    }, ms)
  }))
}

/** The landing cell AS index.ts mounts it: the census first, then the relay. */
async function landingCell(ownerPort: number) {
  const inFlight = new InFlightHandlers()
  const longLived = new LongLivedResponses()
  const middleware = inFlight.middleware()
  const server = createServer((req, res) => middleware(req, res, () => {
    void proxyWorkspaceHttpRequest({
      request: req,
      response: res,
      advertiseUrl: `http://127.0.0.1:${ownerPort}`,
      sourceCellId: 'landing-cell',
      longLived,
      inFlight,
    })
  }))
  const port = await listen(server)
  return { inFlight, longLived, server, port }
}

function sequence(server: Server, inFlight: InFlightHandlers, longLived: LongLivedResponses, overrides: Partial<GracefulShutdownResources> = {}) {
  const noop = () => Promise.resolve()
  const lines: string[] = []
  const events: string[] = []
  const done = runGracefulShutdown('SIGTERM', {
    stopIntake: () => undefined,
    stopStaticProjector: () => undefined,
    stopMaintenanceIntake: () => undefined,
    drainMaintenance: noop,
    closeDurableHeadsDecoder: noop,
    drainAutomerge: noop,
    stopChangeHub: noop,
    closeHttp: async (signalAt) => {
      // The grace (2 s) is above the owner's answer (≤ 0.5 s): a write in
      // flight is SERVED, not cut — what these cases are about.
      await closeHttpServer(server, { inFlight, longLived, graceMs: 2_000, handlerDeadlineAt: signalAt + 3_000, log: (line) => lines.push(line) })
    },
    stopOwnership: async () => { events.push('ownership-released') },
    shutdownAutomerge: noop,
    stopRedis: noop,
    endPools: noop,
    exit: (code) => { events.push(`exit ${code}`) },
    log: (line) => lines.push(line),
    forcedExitMs: 10_000,
    ...overrides,
  })
  return { done, lines, events }
}

describe('the shutdown\'s handler census never leaks', () => {
  it('a relayed SSE the client CLOSED, then SIGTERM: complete, no HandlersStillRunningError, the set empty', async () => {
    const ownerPort = await ownerCell([])
    const { inFlight, longLived, server, port } = await landingCell(ownerPort)
    const stream = send(port, '/api/model/cache/events')
    const response = await stream.response
    response.resume()
    await sleep(100)
    expect(inFlight.size).toBe(1)

    response.destroy() // `visibilitychange`: the page closes its EventSource
    await until(() => inFlight.size === 0)
    expect(inFlight.size).toBe(0)

    const { done, lines, events } = sequence(server, inFlight, longLived)
    await done
    expect(lines.some((line) => line.includes('"outcome":"complete"'))).toBe(true)
    expect(lines.some((line) => line.includes('server.http_handlers_still_running'))).toBe(false)
    expect(events).toEqual(['ownership-released', 'exit 0'])
    expect(inFlight.size).toBe(0)
  })

  it('an ABANDONED relayed read and an abandoned relayed write are released', async () => {
    const ownerPort = await ownerCell([])
    const { inFlight, port } = await landingCell(ownerPort)
    const read = send(port, '/api/model/objects')
    const write = send(port, '/api/model/compact', 'POST')
    read.response.catch(() => undefined)
    write.response.catch(() => undefined)
    await sleep(100)
    expect(inFlight.size).toBe(2)

    read.abort()
    write.abort()
    await until(() => inFlight.size === 0)
    expect(inFlight.size).toBe(0)
  })

  it('a relayed write IN FLIGHT stays counted until the owner answers; ownership is released after', async () => {
    const writes: string[] = []
    const ownerPort = await ownerCell(writes)
    const { inFlight, longLived, server, port } = await landingCell(ownerPort)
    const write = send(port, '/api/model/compact', 'POST')
    await sleep(50)
    expect(inFlight.size).toBe(1)

    const { done, events } = sequence(server, inFlight, longLived, {
      stopOwnership: async () => { events.push(`ownership-released after ${writes.join(',') || 'nothing'}`) },
    })
    await done
    expect((await write.response).statusCode).toBe(200)
    expect(events[0]).toBe('ownership-released after owner-applied')
  })

  it('holdMutatingRoutes: an express app\'s async write is held past its socket\'s close; its reads are not', async () => {
    const inFlight = new InFlightHandlers()
    const app = express()
    app.use(inFlight.middleware())
    holdMutatingRoutes(app, inFlight)
    let releaseWrite: (() => void) | null = null
    app.post('/write', async (_req, res) => {
      await new Promise<void>((resolve) => { releaseWrite = resolve })
      res.end('ok')
    })
    app.get('/read', (_req, res) => { res.write('partial') })
    const port = await listen(createServer(app))

    const write = send(port, '/write', 'POST')
    const read = send(port, '/read')
    write.response.catch(() => undefined)
    await (await read.response).resume()
    await sleep(50)
    expect(inFlight.size).toBe(2)

    write.abort()
    read.abort()
    await sleep(100)
    expect(inFlight.size).toBe(1) // the write's handler still runs

    releaseWrite!()
    await until(() => inFlight.size === 0)
    expect(inFlight.size).toBe(0)
  })
})

describe('the shutdown — durability and budget of the stop', () => {
  /** A cell whose `/write` handler writes into a "Repo" AFTER the drain's flush. */
  async function lateWriter(ms: number) {
    const inFlight = new InFlightHandlers()
    const longLived = new LongLivedResponses()
    const repo = { unsaved: [] as string[], durable: [] as string[] }
    const middleware = inFlight.middleware()
    const server = createServer((req, res) => middleware(req, res, () => {
      void inFlight.hold(req, (async () => {
        await sleep(ms)
        repo.unsaved.push('late-write')
        res.end('ok')
      })())
    }))
    const port = await listen(server)
    const flush = async () => { repo.durable.push(...repo.unsaved.splice(0)) }
    return { inFlight, longLived, server, port, repo, flush }
  }

  it('a write finished after the drain\'s flush is flushed BEFORE ownership is released', async () => {
    const cell = await lateWriter(400)
    const write = send(cell.port, '/write', 'POST')
    await sleep(50)
    const order: string[] = []
    const { done } = sequence(cell.server, cell.inFlight, cell.longLived, {
      drainAutomerge: async () => { await cell.flush(); order.push(`drain flushed [${cell.repo.durable.join(',')}]`) },
      flushLateWrites: async () => { await cell.flush(); order.push(`late flush [${cell.repo.durable.join(',')}]`) },
      stopOwnership: async () => { order.push(`ownership released [${cell.repo.durable.join(',')}]`) },
    })
    await done
    expect((await write.response).statusCode).toBe(200)
    expect(order).toEqual(['drain flushed []', 'late flush [late-write]', 'ownership released [late-write]'])
  })

  it('a late-write flush that does not settle in its bound keeps ownership', async () => {
    const cell = await lateWriter(0)
    const { done, events } = sequence(cell.server, cell.inFlight, cell.longLived, {
      flushLateWrites: () => new Promise<void>(() => {}),
      lateWriteFlushMs: 200,
    })
    const failure = await done.then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(LateWriteFlushTimeoutError)
    expect(events).not.toContain('ownership-released')
  })

  it('the handler deadline is ABSOLUTE, from the signal — not counted from server.close', async () => {
    const cell = await lateWriter(60_000) // never ends within the test
    void send(cell.port, '/write', 'POST').response.catch(() => undefined)
    await sleep(50)
    // `server.close` held by a socket the drain only closes at 1.5 s.
    let lateSocket: () => void = () => {}
    const extra = send(cell.port, '/write', 'POST')
    extra.response.catch(() => undefined)
    lateSocket = extra.abort
    const lines: string[] = []
    const signalledAt = performance.now()
    const failure = await runGracefulShutdown('SIGTERM', {
      stopIntake: () => undefined,
      stopStaticProjector: () => undefined,
      stopMaintenanceIntake: () => undefined,
      drainMaintenance: () => Promise.resolve(),
      closeDurableHeadsDecoder: () => Promise.resolve(),
      drainAutomerge: async () => { await sleep(1_500); lateSocket() },
      stopChangeHub: () => Promise.resolve(),
      closeHttp: (signalAt) => closeHttpServer(cell.server, {
        inFlight: cell.inFlight, graceMs: 5_000, handlerDeadlineAt: signalAt + 600, log: () => undefined,
      }).then(() => undefined),
      stopOwnership: () => Promise.resolve(),
      shutdownAutomerge: () => Promise.resolve(),
      stopRedis: () => Promise.resolve(),
      endPools: () => Promise.resolve(),
      exit: () => undefined,
      log: (line) => lines.push(line),
      forcedExitMs: 10_000,
    }).then(() => null, (error: unknown) => error)
    const elapsed = performance.now() - signalledAt
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(1)
    // allSettled waits for the drain (1.5 s); the http step itself rejected AT
    // its deadline (signal + 0.6 s), not 0.6 s after server.close's callback,
    // which the late socket holds until ≥ 1.5 s.
    const trace = JSON.parse(lines.find((line) => line.includes('server.shutdown_trace'))!) as { steps: { step: string; endMs?: number }[] }
    const httpEnd = trace.steps.find((step) => step.step === 'http')!.endMs!
    expect(httpEnd).toBeGreaterThanOrEqual(580)
    expect(httpEnd).toBeLessThan(1_200)
    expect(elapsed).toBeLessThan(2_500)
  }, 20_000)
})
