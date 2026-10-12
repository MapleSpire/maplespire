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

import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { listenReady } from './listen.js'

const close = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()))

describe('listenReady', () => {
  it('resolves once the server is bound', async () => {
    const server = createServer()
    server.listen(0, '127.0.0.1')
    await listenReady(server)
    expect(server.listening).toBe(true)
    await close(server)
  })

  // Regression: the sync server keeps itself alive through
  // `process.on('uncaughtException')`, which also swallows the throw Node
  // performs for an unhandled 'error' event. A replica that could not bind its
  // port must NOT survive as a zombie — alive to the orchestrator and renewing
  // its sync-cell partition leases while serving nothing.
  it('rejects when the port is already bound instead of emitting an unhandled error', async () => {
    const holder = createServer()
    holder.listen(0, '127.0.0.1')
    await listenReady(holder)
    const { port } = holder.address() as AddressInfo

    const loser = createServer()
    loser.listen(port, '127.0.0.1')
    await expect(listenReady(loser)).rejects.toMatchObject({ code: 'EADDRINUSE' })

    await close(loser)
    await close(holder)
  })

  // Guards the actual production wiring: index.ts must not fall back to
  // `uncaughtException` for the bind failure. If the helper left its 'error'
  // listener attached only until the promise settled, a *second* error would
  // still reach the process handler; the caller installs a durable handler
  // afterwards, so the helper must leave the emitter clean.
  // Compared against a baseline, not zero: http.Server registers its own
  // permanent 'listening' listener (setupConnectionsTracking) at construction.
  it('leaves no listeners of its own behind once settled', async () => {
    const server = createServer()
    const baseline = {
      error: server.listenerCount('error'),
      listening: server.listenerCount('listening'),
    }
    server.listen(0, '127.0.0.1')
    await listenReady(server)
    expect(server.listenerCount('error')).toBe(baseline.error)
    expect(server.listenerCount('listening')).toBe(baseline.listening)
    await close(server)
  })

  // The failure path must clean up too — index.ts installs a durable 'error'
  // handler after the bind, and a leftover reject listener would make a later
  // error settle an already-settled promise and vanish silently.
  it('leaves no listeners of its own behind after a failed bind', async () => {
    const holder = createServer()
    holder.listen(0, '127.0.0.1')
    await listenReady(holder)
    const { port } = holder.address() as AddressInfo

    const loser = createServer()
    const baseline = {
      error: loser.listenerCount('error'),
      listening: loser.listenerCount('listening'),
    }
    loser.listen(port, '127.0.0.1')
    await expect(listenReady(loser)).rejects.toThrow()
    expect(loser.listenerCount('error')).toBe(baseline.error)
    expect(loser.listenerCount('listening')).toBe(baseline.listening)

    await close(holder)
  })

  it('resolves immediately when the server is already listening', async () => {
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    await expect(listenReady(server)).resolves.toBeUndefined()
    await close(server)
  })
})
