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

import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { proxyWorkspaceHttpRequest } from './httpProxy.js'

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port')
  return address.port
}

describe('proxyWorkspaceHttpRequest', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('streams an SSE response without applying the setup deadline to the live stream', async () => {
    const owner = createServer((_request, response) => {
      response.statusCode = 200
      response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      response.write('event: ready\ndata: {"generation":1}\n\n')
      // Keep the stream alive past the setup deadline. A generous loopback
      // setup budget avoids turning concurrent Vitest worker scheduling into a
      // false proxy failure while still proving the timer is cleared on headers.
      setTimeout(() => response.end('event: invalidate\ndata: {"generation":2}\n\n'), 400)
    })
    servers.push(owner)
    const ownerPort = await listen(owner)

    const landing = createServer((request, response) => {
      void proxyWorkspaceHttpRequest({
        request,
        response,
        advertiseUrl: `http://127.0.0.1:${ownerPort}`,
        sourceCellId: 'landing-cell',
        timeoutMs: 250,
      })
    })
    servers.push(landing)
    const landingPort = await listen(landing)

    const response = await fetch(`http://127.0.0.1:${landingPort}/api/model/cache/events`)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-maplespire-sync-route')).toBe('proxied')
    const body = await response.text()
    expect(body).toContain('event: ready')
    expect(body).toContain('event: invalidate')
  })

  it('fails closed for an unsafe advertised origin', async () => {
    const landing = createServer((request, response) => {
      void proxyWorkspaceHttpRequest({
        request,
        response,
        advertiseUrl: 'http://user:secret@127.0.0.1:1',
        sourceCellId: 'landing-cell',
      })
    })
    servers.push(landing)
    const port = await listen(landing)
    const response = await fetch(`http://127.0.0.1:${port}/api/model/search`)
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ retryable: true })
  })

  it('re-serializes the bounded durability JSON body for the owning cell', async () => {
    let ownerBody = ''
    const owner = createServer((request, response) => {
      request.setEncoding('utf8')
      request.on('data', (chunk) => { ownerBody += chunk })
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ ok: true }))
      })
    })
    servers.push(owner)
    const ownerPort = await listen(owner)
    const payload = { documents: [{ documentId: 'doc', heads: ['a'.repeat(64)] }] }

    const landing = createServer((request, response) => {
      let raw = ''
      request.setEncoding('utf8')
      request.on('data', (chunk) => { raw += chunk })
      request.on('end', () => {
        ;(request as typeof request & { body: unknown }).body = JSON.parse(raw)
        void proxyWorkspaceHttpRequest({
          request,
          response,
          advertiseUrl: `http://127.0.0.1:${ownerPort}`,
          sourceCellId: 'landing-cell',
        })
      })
    })
    servers.push(landing)
    const landingPort = await listen(landing)

    const response = await fetch(`http://127.0.0.1:${landingPort}/api/automerge/durable-heads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(ownerBody)).toEqual(payload)
  })

  it('CLEARS the connect deadline on connect, so a slow OWNER is not cut off by a CONNECTION bound', async () => {
    // This arm is what makes the two bounds two rather than a rename. The owner connects immediately and answers 300 ms later. The
    // connect bound is 50 ms and the header bound is 3 s: without the
    // `once('socket')` → `once('connect')` clear, the 50 ms timer fires on a
    // connection that was established in under a millisecond and the caller
    // gets a 503 for a healthy owner.
    //
    // `connectTimeoutMs` is overridable for exactly this: at their production
    // defaults the two bounds are both 5 s and no test can tell them apart.
    const owner = createServer((_request, response) => {
      setTimeout(() => {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ ok: true }))
      }, 300)
    })
    servers.push(owner)
    const ownerPort = await listen(owner)

    const landing = createServer((request, response) => {
      void proxyWorkspaceHttpRequest({
        request,
        response,
        advertiseUrl: `http://127.0.0.1:${ownerPort}`,
        sourceCellId: 'landing-cell',
        connectTimeoutMs: 50,
        timeoutMs: 3_000,
      })
    })
    servers.push(landing)
    const landingPort = await listen(landing)

    const answer = await fetch(`http://127.0.0.1:${landingPort}/api/automerge/root`)
    expect(answer.status, 'a connection bound cut off a healthy owner').toBe(200)
    await expect(answer.json()).resolves.toEqual({ ok: true })
  })

  it('still refuses when the HEADER deadline passes, so the long bound is a bound', async () => {
    // The control for the arm above. Without it, a proxy that never armed the
    // header timer at all would pass it.
    const owner = createServer((_request, response) => {
      setTimeout(() => response.end('{}'), 2_000)
    })
    servers.push(owner)
    const ownerPort = await listen(owner)

    const landing = createServer((request, response) => {
      void proxyWorkspaceHttpRequest({
        request,
        response,
        advertiseUrl: `http://127.0.0.1:${ownerPort}`,
        sourceCellId: 'landing-cell',
        connectTimeoutMs: 3_000,
        timeoutMs: 120,
      })
    })
    servers.push(landing)
    const landingPort = await listen(landing)

    const answer = await fetch(`http://127.0.0.1:${landingPort}/api/automerge/root`)
    expect(answer.status).toBe(503)
    await expect(answer.json()).resolves.toMatchObject({ retryable: true })
  })

  it('SETTLES when the client goes away, instead of leaving the promise (and its body) alive', async () => {
    // If the `aborted` and `close` handlers cleared nothing, a long header
    // deadline would leave the executor's closure, and with it a re-serialised
    // body of up to `express.json`'s 50 MB limit, reachable until the timer
    // fires. `unref()` keeps a timer out of the exit accounting; it does not
    // release what the timer retains.
    //
    // WHAT THIS ARM PINS, EXACTLY: the PAIR. Removing `settle(false)` from
    // `aborted`, or from `close`, or removing the `upstream.destroy()`, leaves
    // it green — on this runtime `upstream.destroy()` emits `error`, whose
    // handler settles too. Making BOTH handlers inert turns it red. The three
    // paths are defence-in-depth over one property. NOT covered here: the
    // `serializedBody` release and `fail()`'s `response.destroyed` guard.
    //
    // The bound here is 30 s. If the promise did not settle on the client's
    // disconnect this arm would time out rather than fail — which is the honest
    // shape for "it never settles".
    const owner = createServer(() => { /* accept, and never answer */ })
    servers.push(owner)
    const ownerPort = await listen(owner)

    let settledWith: boolean | 'pending' = 'pending'
    const landing = createServer((request, response) => {
      void proxyWorkspaceHttpRequest({
        request,
        response,
        advertiseUrl: `http://127.0.0.1:${ownerPort}`,
        sourceCellId: 'landing-cell',
        timeoutMs: 30_000,
        connectTimeoutMs: 30_000,
      }).then((value) => { settledWith = value })
    })
    servers.push(landing)
    const landingPort = await listen(landing)

    const abort = new AbortController()
    const inFlight = fetch(`http://127.0.0.1:${landingPort}/api/automerge/root`, { signal: abort.signal })
    await new Promise((resolve) => setTimeout(resolve, 100))
    abort.abort()
    await expect(inFlight).rejects.toThrow()

    const deadline = Date.now() + 3_000
    while (settledWith === 'pending' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(settledWith, 'the proxy promise never settled after the client disconnected').toBe(false)
  }, 20_000)
})
