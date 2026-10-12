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

import { EventEmitter, once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { closeAutomergeSockets, drainAutomergeResources, runShutdownSteps } from './automergeDrain.js'
import { startWorkspaceCacheInvalidation } from './rbac/workspaceCacheInvalidation.js'

afterEach(() => vi.useRealTimers())

describe('Automerge drain failure propagation', () => {
  it.each(['internal-http', 'no-server'] as const)('joins real %s WebSocket closure and attempts flush before reporting failed UNLISTEN', async (mode) => {
    const unlistenFailure = new Error('controlled UNLISTEN failure')
    const pgClient = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('UNLISTEN ')) throw unlistenFailure
        return { rows: [] }
      }),
      release: vi.fn(),
    })
    const listener = startWorkspaceCacheInvalidation({ connect: async () => pgClient } as never,
      { onCoverageChanged: () => {}, onVersionCreated: () => {} })
    const http = mode === 'no-server' ? createServer() : null
    const wss = http ? new WebSocketServer({ noServer: true }) : new WebSocketServer({ host: '127.0.0.1', port: 0 })
    if (http) {
      http.on('upgrade', (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, connection => wss.emit('connection', connection, request))
      })
      http.listen(0, '127.0.0.1')
    }
    let socket: WebSocket | undefined
    const order: string[] = []
    let serverClosed = false
    wss.once('close', () => { serverClosed = true; order.push('sockets closed') })
    try {
      await once(http ?? wss, 'listening')
      const address = http ? http.address() : wss.address()
      if (!address || typeof address === 'string') throw new Error('Test WSS has no allocated TCP port')
      socket = new WebSocket(`ws://127.0.0.1:${address.port}`)
      await once(socket, 'open')
      const clientClosed = once(socket, 'close')
      await vi.waitFor(() => expect(pgClient.query).toHaveBeenCalledWith('LISTEN workspace_version_created'))
      expect(wss.clients.size).toBe(1)
      const flush = vi.fn(async () => {
        order.push('flush')
        expect(serverClosed).toBe(true)
        expect(wss.clients.size).toBe(0)
      })
      const result = await drainAutomergeResources({
        stopEpochRevocation: () => {},
        stopWorkspaceCacheInvalidation: () => listener.stop(),
        wss,
        drainResidency: async () => { order.push('residency') },
        restoreInboundQueue: () => { order.push('restore') },
        flush,
      }).then(() => null, error => error)
      order.push('rejected')
      expect(result).toBeInstanceOf(AggregateError)
      expect(result.errors.map((entry: Error) => entry.cause)).toEqual([unlistenFailure])
      expect(flush).toHaveBeenCalledOnce()
      expect(order).toEqual(['sockets closed', 'residency', 'restore', 'flush', 'rejected'])
      expect(pgClient.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
      const [code] = await clientClosed
      expect(code).toBe(1012)
      expect(socket.readyState).toBe(WebSocket.CLOSED)
    } finally {
      await listener.stop().catch(() => {}) // the expected error is asserted above
      socket?.terminate()
      if (!serverClosed) {
        for (const client of wss.clients) client.terminate()
        await new Promise<void>((resolve, reject) => wss.close(error => error ? reject(error) : resolve()))
      }
      if (http) await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()))
    }
  })

  it('joins later work and preserves all failures, including synchronous throws', async () => {
    let finish: () => void = () => { throw new Error('Deferred drain was not initialized') }
    const pending = new Promise<void>(resolve => { finish = resolve })
    const first = new Error('listener'), second = new Error('flush')
    const last = vi.fn()
    let settled = false
    const result = runShutdownSteps('test drain', [
      { name: 'listener', run: () => { throw first } },
      { name: 'joined operation', run: () => pending },
      { name: 'flush', run: async () => { throw second } },
      { name: 'last cleanup', run: last },
    ]).then(() => { settled = true; return null }, error => { settled = true; return error })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(last).not.toHaveBeenCalled()
    finish()
    const error = await result
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors.map((entry: Error) => entry.cause)).toEqual([first, second])
    expect(last).toHaveBeenCalledOnce()
  })

  it('continues drain after a suspended UNLISTEN misses its 2000 ms join bound', async () => {
    vi.useFakeTimers()
    let finishQuery: () => void = () => { throw new Error('UNLISTEN not initialized') }
    const pendingQuery = new Promise<void>(resolve => { finishQuery = resolve })
    const pgClient = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => { if (sql.startsWith('UNLISTEN ')) await pendingQuery; return { rows: [] } }),
      release: vi.fn(),
    })
    const listener = startWorkspaceCacheInvalidation({ connect: async () => pgClient } as never,
      { onCoverageChanged: () => {}, onVersionCreated: () => {} })
    await vi.advanceTimersByTimeAsync(0)
    const flush = vi.fn(async () => {})
    const closing = vi.fn((callback: () => void) => callback())
    const result = drainAutomergeResources({
      stopEpochRevocation: () => {}, stopWorkspaceCacheInvalidation: () => listener.stop(),
      wss: { clients: new Set(), close: closing } as never,
      drainResidency: () => {}, restoreInboundQueue: () => {}, flush,
    }).then(() => null, error => error)
    await vi.advanceTimersByTimeAsync(1999)
    expect(closing).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    const error = await result
    expect(error).toBeInstanceOf(AggregateError)
    expect(String(error.errors[0].cause)).toContain('UNLISTEN')
    expect(closing).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
    expect(pgClient.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error))
    finishQuery()
    await vi.advanceTimersByTimeAsync(0)
    expect(pgClient.query.mock.calls.filter(([sql]) => sql.startsWith('UNLISTEN '))).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a socket termination deadline does not stand in for the WSS close callback', async () => {
    vi.useFakeTimers()
    let closeCallback: (error?: Error) => void = () => { throw new Error('WSS close was not called') }
    const client = Object.assign(new EventEmitter(), { close: vi.fn(), terminate: vi.fn() })
    const wss = { clients: new Set([client]), close: vi.fn(callback => { closeCallback = callback }) }
    let closed = false
    const joining = closeAutomergeSockets(wss as never).then(() => { closed = true })
    expect(client.close).toHaveBeenCalledExactlyOnceWith(1012, 'Server restarting')
    await vi.advanceTimersByTimeAsync(4999)
    expect(client.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(client.terminate).toHaveBeenCalledOnce()
    expect(closed).toBe(false)
    client.emit('close')
    await Promise.resolve()
    expect(closed).toBe(false)
    closeCallback()
    await joining
    expect(closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('joins a pending flush on the healthy path without waiting for the socket deadline', async () => {
    vi.useFakeTimers()
    let finishFlush: () => void = () => { throw new Error('Flush not initialized') }
    const pendingFlush = new Promise<void>(resolve => { finishFlush = resolve })
    const order: string[] = []
    let settled = false
    const draining = drainAutomergeResources({
      stopEpochRevocation: async () => { order.push('epoch') },
      stopWorkspaceCacheInvalidation: async () => { order.push('listener') },
      wss: { clients: new Set(), close: (callback: () => void) => { callback(); return undefined as never } } as never,
      drainResidency: async () => { order.push('residency') },
      restoreInboundQueue: () => { order.push('restore') },
      flush: async () => { order.push('flush'); await pendingFlush },
    }).then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(['epoch', 'listener', 'residency', 'restore', 'flush'])
    expect(settled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    finishFlush()
    await draining
    expect(settled).toBe(true)
  })

  it('joins an already CLOSED tracked socket and removes its close observer', async () => {
    const client = Object.assign(new EventEmitter(), {
      readyState: WebSocket.CLOSED, close: vi.fn(), terminate: vi.fn(),
    })
    await closeAutomergeSockets({
      clients: new Set([client]), close: (callback: () => void) => callback(),
    } as never)
    expect(client.listenerCount('close')).toBe(0)
  })

  it('the real drain and process signal consumer retain the failure guard before ownership release', () => {
    // index.ts boots the application on import; this pin complements the
    // executable helper tests by checking that the boot-time consumer uses it.
    const server = readFileSync(new URL('./automergeServer.ts', import.meta.url), 'utf8')
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(server).toContain('await drainAutomergeResources({')
    expect(server).toContain('stopWorkspaceCacheInvalidation: () => workspaceCacheInvalidation?.stop()')
    const start = index.indexOf('const drainResults = await Promise.allSettled([')
    const release = index.indexOf('await syncCellOwnership?.stop()', start)
    expect(start).toBeGreaterThan(0)
    expect(release).toBeGreaterThan(start)
    const beforeRelease = index.slice(start, release)
    expect(beforeRelease).toContain("result.status === 'rejected'")
    expect(beforeRelease).toContain('if (failedDrains.length) throw new AggregateError(')
    expect(index).toContain('void shutdown(signal).catch((error) => {')
    expect(index).toContain("console.error('[server] graceful shutdown failed; forced-exit deadline remains active:', error)")
    expect(index).toContain('process.exitCode = 1')
  })
})
