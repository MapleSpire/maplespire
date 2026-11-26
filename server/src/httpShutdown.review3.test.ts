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
 * T-DIAGDEF: the shutdown's census and grace cut, over real sockets:
 *
 *  - a request whose client went away BEFORE its handler began (the POST
 *    fully received, `requireAuth` still awaiting) is counted again by the
 *    handler's hold: its write cannot escape the census;
 *  - the grace cut spares a connection a running handler holds: a 1.5 s
 *    write past a 0.3 s grace gets its 200; a stuck unheld request is still
 *    cut at the grace.
 */

import { once } from 'node:events'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'

import { closeHttpServer, InFlightHandlers } from './httpShutdown.js'

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('the shutdown — a hold re-counts a request its close released', () => {
  it('close, THEN hold: idle() is false until the handler\'s promise settles', async () => {
    const inFlight = new InFlightHandlers()
    const middleware = inFlight.middleware()
    let startHandler!: () => void
    let finishWrite!: () => void
    const port = await listen(createServer((req, res) => middleware(req, res, () => {
      // `requireAuth` still awaiting when the client goes away; then the
      // `route()` handler begins its write.
      startHandler = () => {
        void inFlight.hold(req, new Promise<void>((resolve) => { finishWrite = resolve }))
      }
      void res
    })))
    const post = send(port, '/write', 'POST')
    post.response.catch(() => undefined)
    await sleep(50)
    post.abort()
    for (let i = 0; i < 50 && inFlight.size; i += 1) await sleep(10)
    expect(inFlight.size).toBe(0) // the close released the unheld request

    startHandler()
    expect(inFlight.size).toBe(1)
    expect(await inFlight.idle(100)).toBe(false)

    finishWrite()
    await sleep(0)
    expect(await inFlight.idle(100)).toBe(true)
  })
})

describe('the shutdown — the grace cut spares a held write', () => {
  it('a write past the grace receives its response; an unheld stuck request is cut at the grace', async () => {
    const inFlight = new InFlightHandlers()
    const middleware = inFlight.middleware()
    const server = createServer((req, res) => middleware(req, res, () => {
      if (req.url === '/write') {
        void inFlight.hold(req, (async () => {
          await sleep(1_500)
          res.end('ok')
        })())
      }
      // '/stuck': never answers, never held
    }))
    const port = await listen(server)
    const write = send(port, '/write', 'POST')
    const stuck = send(port, '/stuck')
    const stuckOutcome = stuck.response.then(() => 'answered', () => performance.now())
    await sleep(50)

    const startedAt = performance.now()
    const outcome = await closeHttpServer(server, {
      inFlight, graceMs: 300, handlerDeadlineAt: startedAt + 5_000, log: () => undefined,
    })

    expect((await write.response).statusCode).toBe(200)
    const stuckCutAt = await stuckOutcome
    expect(typeof stuckCutAt).toBe('number')
    expect((stuckCutAt as number) - startedAt).toBeLessThan(1_000)
    expect(outcome.forcedConnections).toBe(true)
  })
})
