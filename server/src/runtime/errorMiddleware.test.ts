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

import express from 'express'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminalErrorHandler } from './errorMiddleware.js'
import { RedisUnavailableError } from './redis.js'
import { StaleSyncCellWriteError } from '../automergeStorageErrors.js'
import { dependencyOutageResponse } from './dependencyOutageResponse.js'

/**
 * Driven through a REAL Express app over a real socket rather than by calling
 * the handler with fake req/res objects. Two of the three things that can go
 * wrong here are properties of Express's dispatch, not of the function body:
 * whether a 4-arity handler is recognised as error middleware at all, and
 * whether a rejected async handler reaches it. A hand-rolled `res` double would
 * assert neither.
 */
describe('terminal error handler', () => {
  const servers: Array<{ close: () => void }> = []

  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  async function serve(build: (app: express.Express) => void): Promise<string> {
    const app = express()
    build(app)
    // Mounted last, exactly as main() must mount it.
    app.use(terminalErrorHandler({ log: () => {} }))
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    servers.push(server)
    const { port } = server.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  it('answers a rejected async handler with JSON, not an HTML error page', async () => {
    const base = await serve((app) => {
      app.get('/boom', async () => { throw new Error('kaboom') })
    })

    const response = await fetch(`${base}/boom`)

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ error: 'internal_error' })
  })

  it('never leaks the error text — this handler also catches unauthenticated routes', async () => {
    const base = await serve((app) => {
      app.get('/leak', async () => {
        throw new Error('postgres://maplespire:hunter2@db.internal:5432/maplespire')
      })
    })

    const body = await (await fetch(`${base}/leak`)).text()

    expect(body).not.toContain('hunter2')
    expect(body).not.toContain('postgres://')
  })

  it('answers a Redis outage with a retryable 503, matching the inline routes', async () => {
    // The failure mode this exists for: an ElastiCache failover turning the
    // login endpoint's rate-limit check into an HTML 500 that no client can
    // distinguish from a permanent bug.
    const base = await serve((app) => {
      app.get('/login', async () => { throw new RedisUnavailableError() })
    })

    const response = await fetch(`${base}/login`)

    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('1')
    expect(await response.json()).toEqual({
      error: 'rate_limit_unavailable',
      // Additive: `error` is byte-identical for the clients that parse it, and
      // `code` is the field every response from the shared mapping carries, so
      // a client has one field to switch on.
      code: 'rate_limit_unavailable',
      message: 'This operation is temporarily unavailable.',
    })
  })

  it('answers a fence refusal with the SAME contract `route()` answers', async () => {
    // These two doors cover disjoint routes and neither can reach the other — `route()` catches
    // its own rejections and never calls `next(err)` — so a client's answer must
    // not depend on which door it arrived at. The literals are pinned in
    // `dependencyOutageResponse.test.ts`; what this arm proves is that the
    // terminal handler delivers them over a real socket, headers included.
    const refusal = new StaleSyncCellWriteError('snapshot', 'ownership-unavailable')
    const base = await serve((app) => {
      app.get('/unwrapped', async () => { throw refusal })
    })

    const response = await fetch(`${base}/unwrapped`)

    const shared = dependencyOutageResponse(refusal)!
    expect(response.status).toBe(shared.status)
    expect(response.headers.get('retry-after')).toBe(shared.headers['Retry-After'])
    expect(await response.json()).toEqual(shared.body)
  })

  it('names the failed subsystem in the log, not just in the body', async () => {
    // The body names the failed subsystem; an operator reads the LOG first, so
    // it has to agree — and it derives from the same field rather than a
    // string copied by hand beside it.
    const log = vi.fn()
    const app = express()
    app.get('/boom', async () => { throw new StaleSyncCellWriteError('snapshot', 'fence-mismatch') })
    app.use(terminalErrorHandler({ log }))
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    servers.push(server)
    const { port } = server.address() as AddressInfo

    await fetch(`http://127.0.0.1:${port}/boom`)

    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toContain('sync-cell ownership')
    expect(log.mock.calls[0]![0]).not.toContain('unhandled error')
  })

  it('catches a synchronous throw as well as a rejection', async () => {
    const base = await serve((app) => {
      app.get('/sync-boom', () => { throw new Error('kaboom') })
    })

    expect((await fetch(`${base}/sync-boom`)).status).toBe(500)
  })

  it('never appends to a response that already started', async () => {
    // Status and part of the body are already on the wire, so writing a second
    // payload would corrupt it — the client would parse `partial{"error":…}`.
    // `fetch` still RESOLVES here, because the headers arrived before the throw;
    // the property under test is what does or does not follow them.
    const base = await serve((app) => {
      app.get('/half-sent', (_req, res) => {
        res.status(200).write('partial')
        throw new Error('after headers')
      })
    })

    const response = await fetch(`${base}/half-sent`)
    expect(response.status).toBe(200)
    // Express's default handler destroys the socket, so reading may throw; that
    // is fine. What must never happen is a well-formed body carrying our JSON.
    const body = await response.text().catch(() => '')
    expect(body).not.toContain('internal_error')
  })

  it('is recognised by Express as error middleware', () => {
    // Express identifies error middleware by arity alone. Drop the unused
    // `next` parameter and this registers as ordinary middleware that never
    // runs on the error path — a silent, total failure of the module.
    expect(terminalErrorHandler().length).toBe(4)
  })

  it('reports the failure rather than swallowing it', async () => {
    const log = vi.fn()
    const app = express()
    app.get('/boom', async () => { throw new Error('kaboom') })
    app.use(terminalErrorHandler({ log }))
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    servers.push(server)
    const { port } = server.address() as AddressInfo

    await fetch(`http://127.0.0.1:${port}/boom`)

    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]![0]).toContain('/boom')
  })
})
