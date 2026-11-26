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
 * T-DIAGDEF, over a real express app and real sockets:
 * the census is SEALED when the HTTP step resolves, and a handler that begins
 * after it — its `requireAuth` still awaiting when the step resolved — does
 * not run its work; it answers 503, retryable.
 *
 * Before: the step resolved (the request's client had gone, its census token
 * was released by the close), then `requireAuth` resolved and the handler ran
 * — writing after the late-write flush and after the lease was released, with
 * nobody counting it.
 */

import { once } from 'node:events'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'

import { closeHttpServer, holdHandler, holdMutatingRoutes, InFlightHandlers } from './httpShutdown.js'
import { route } from './routeErrors.js'

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

function send(port: number, path: string, method = 'GET') {
  let abort = () => {}
  const response = new Promise<IncomingMessage>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, resolve)
    req.on('error', reject)
    abort = () => req.destroy()
    req.end()
  })
  return { response, abort }
}

async function body(response: IncomingMessage): Promise<string> {
  let text = ''
  response.setEncoding('utf8')
  for await (const chunk of response) text += chunk
  return text
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The index.ts stack in miniature: the census first, the held app, a
 * `requireAuth` that waits on `gate`, then the routes. */
function app(inFlight: InFlightHandlers, executed: string[]) {
  let openGate!: () => void
  const gate = new Promise<void>((resolve) => { openGate = resolve })
  const application = express()
  application.use(inFlight.middleware())
  holdMutatingRoutes(application, inFlight)
  application.use(async (_req, _res, next) => { await gate; next() }) // requireAuth, delayed
  application.post('/write', async (_req, res) => {
    executed.push('POST /write')
    await sleep(10)
    res.json({ ok: true })
  })
  return { application, openGate }
}

describe('the shutdown — a handler that begins after the HTTP step does not run', () => {
  it('the step resolves while requireAuth awaits; the handler then begins: its work is NOT run', async () => {
    const inFlight = new InFlightHandlers()
    const executed: string[] = []
    const { application, openGate } = app(inFlight, executed)
    const server = createServer(application)
    const port = await listen(server)

    // The POST fully received, `requireAuth` awaiting, the client gone.
    const post = send(port, '/write', 'POST')
    post.response.catch(() => undefined)
    await sleep(50)
    post.abort()
    for (let i = 0; i < 50 && inFlight.size; i += 1) await sleep(10)
    expect(inFlight.size).toBe(0) // released by the close: nothing to wait for

    const startedAt = performance.now()
    await closeHttpServer(server, { inFlight, graceMs: 300, handlerDeadlineAt: startedAt + 5_000, log: () => undefined })
    // The HTTP step is over (`runGracefulShutdown` goes on to the late-write
    // flush and the lease). NOW `requireAuth` resolves.
    openGate()
    await sleep(100)

    expect(executed).toEqual([]) // before: ['POST /write'] — a write nobody counted
    expect(inFlight.sealed).toBe(true)
    expect(inFlight.refused).toBe(1)
    expect(inFlight.size).toBe(0)
  })

  it('a client still connected receives the 503, retryable — held route, route(), and a GET through route()', async () => {
    const inFlight = new InFlightHandlers()
    const executed: string[] = []
    const { application, openGate } = app(inFlight, executed)
    // `index.ts`'s route(): `route(holdHandler(inFlightHandlers, handler))`.
    application.post('/routed', route(holdHandler(inFlight, async (_req, res) => {
      executed.push('POST /routed')
      res.json({ ok: true })
    })))
    application.get('/read', route(holdHandler(inFlight, async (_req, res) => {
      executed.push('GET /read')
      res.json({ ok: true })
    })))
    const port = await listen(createServer(application))

    const requests = [send(port, '/write', 'POST'), send(port, '/routed', 'POST'), send(port, '/read')]
    await sleep(50)
    // What `closeHttpServer` does as it resolves. (A client still connected
    // keeps the real step waiting until the grace cuts it, so the seal is
    // called directly here; the test above has the real step.)
    inFlight.seal()
    openGate()

    for (const { response } of requests) {
      const answered = await response
      expect(answered.statusCode).toBe(503)
      expect(answered.headers['retry-after']).toBe('2')
      expect(JSON.parse(await body(answered))).toEqual({ error: 'server shutting down', code: 'SHUTTING_DOWN', retryable: true })
    }
    expect(executed).toEqual([])
    expect(inFlight.refused).toBe(3)
  })

  it('control: before the seal the same handlers run and answer 200', async () => {
    const inFlight = new InFlightHandlers()
    const executed: string[] = []
    const { application, openGate } = app(inFlight, executed)
    application.post('/routed', route(holdHandler(inFlight, async (_req, res) => {
      executed.push('POST /routed')
      res.json({ ok: true })
    })))
    const port = await listen(createServer(application))
    openGate()
    expect((await send(port, '/write', 'POST').response).statusCode).toBe(200)
    expect((await send(port, '/routed', 'POST').response).statusCode).toBe(200)
    expect(executed).toEqual(['POST /write', 'POST /routed'])
    expect(inFlight.refused).toBe(0)
  })
})
