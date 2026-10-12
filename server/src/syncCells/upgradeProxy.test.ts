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
import WebSocket, { WebSocketServer } from 'ws'
import { proxyWorkspaceUpgrade } from './upgradeProxy.js'

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port')
  return address.port
}

describe('proxyWorkspaceUpgrade', () => {
  const servers: Server[] = []
  const sockets: WebSocket[] = []

  afterEach(async () => {
    for (const socket of sockets) socket.terminate()
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('preserves the workspace, cookie and bidirectional WebSocket stream', async () => {
    let observedUrl = ''
    let observedCookie = ''
    let observedSourceCell = ''
    const ownerHttp = createServer()
    const ownerWs = new WebSocketServer({ noServer: true })
    servers.push(ownerHttp)
    ownerHttp.on('upgrade', (request, socket, head) => {
      observedUrl = request.url ?? ''
      observedCookie = request.headers.cookie ?? ''
      observedSourceCell = String(request.headers['x-maplespire-sync-routed'] ?? '')
      ownerWs.handleUpgrade(request, socket, head, (ws) => {
        sockets.push(ws)
        ws.on('message', (message) => ws.send(`owner:${message.toString()}`))
        ws.send('owner-ready')
      })
    })
    const ownerPort = await listen(ownerHttp)

    const router = createServer()
    servers.push(router)
    router.on('upgrade', (request, socket, head) => {
      void proxyWorkspaceUpgrade({
        request,
        socket,
        head,
        advertiseUrl: `http://127.0.0.1:${ownerPort}`,
        sourceCellId: 'cell-router',
      })
    })
    const routerPort = await listen(router)

    const client = new WebSocket(
      `ws://127.0.0.1:${routerPort}/automerge?landscapeId=landscape-1&versionId=version-7`,
      { headers: { Cookie: 'maplespire_session=opaque', 'x-maplespire-sync-routed': 'untrusted-client' } },
    )
    sockets.push(client)
    const [ready] = await once(client, 'message')
    expect(ready.toString()).toBe('owner-ready')
    client.send('ping')
    const [echo] = await once(client, 'message')
    expect(echo.toString()).toBe('owner:ping')
    expect(observedUrl).toBe('/automerge?landscapeId=landscape-1&versionId=version-7')
    expect(observedCookie).toBe('maplespire_session=opaque')
    expect(observedSourceCell).toBe('cell-router')
  })

  it('returns the owner refusal without opening a local WebSocket', async () => {
    const ownerHttp = createServer()
    servers.push(ownerHttp)
    ownerHttp.on('upgrade', (_request, socket) => {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    })
    const ownerPort = await listen(ownerHttp)

    const router = createServer()
    servers.push(router)
    router.on('upgrade', (request, socket, head) => {
      void proxyWorkspaceUpgrade({
        request,
        socket,
        head,
        advertiseUrl: `http://127.0.0.1:${ownerPort}`,
        sourceCellId: 'cell-router',
      })
    })
    const routerPort = await listen(router)
    const client = new WebSocket(
      `ws://127.0.0.1:${routerPort}/automerge?landscapeId=landscape-1&versionId=version-7`,
    )
    client.on('error', () => undefined)
    const [, response] = await once(client, 'unexpected-response')
    expect(response.statusCode).toBe(403)
    response.resume()
    await once(response, 'end')
  })

  it('exposes a graceful 1012 tunnel close for owner handoff', async () => {
    const ownerHttp = createServer()
    const ownerWs = new WebSocketServer({ noServer: true })
    servers.push(ownerHttp)
    ownerHttp.on('upgrade', (request, socket, head) => {
      ownerWs.handleUpgrade(request, socket, head, (ws) => {
        sockets.push(ws)
        ws.send('owner-ready')
      })
    })
    const ownerPort = await listen(ownerHttp)
    let closeTunnel: (() => void) | undefined
    const router = createServer()
    servers.push(router)
    router.on('upgrade', (request, socket, head) => {
      void proxyWorkspaceUpgrade({
        request,
        socket,
        head,
        advertiseUrl: `http://127.0.0.1:${ownerPort}`,
        sourceCellId: 'cell-router',
        onConnected: (tunnel) => { closeTunnel = () => tunnel.close(1012, 'Workspace owner changed') },
      })
    })
    const routerPort = await listen(router)
    const client = new WebSocket(
      `ws://127.0.0.1:${routerPort}/automerge?landscapeId=landscape-1&versionId=version-7`,
    )
    sockets.push(client)
    await once(client, 'message')
    expect(closeTunnel).toBeDefined()
    closeTunnel?.()
    const [code, reason] = await once(client, 'close')
    expect(code).toBe(1012)
    expect(reason.toString()).toBe('Workspace owner changed')
  })

  it('returns a retryable 503 when a pending owner upgrade is aborted', async () => {
    const ownerHttp = createServer()
    servers.push(ownerHttp)
    ownerHttp.on('upgrade', () => undefined)
    const ownerPort = await listen(ownerHttp)

    const controller = new AbortController()
    const router = createServer()
    servers.push(router)
    router.on('upgrade', (request, socket, head) => {
      void proxyWorkspaceUpgrade({
        request,
        socket,
        head,
        advertiseUrl: `http://127.0.0.1:${ownerPort}`,
        sourceCellId: 'cell-router',
        signal: controller.signal,
      })
    })
    const routerPort = await listen(router)
    const client = new WebSocket(
      `ws://127.0.0.1:${routerPort}/automerge?landscapeId=landscape-1&versionId=version-7`,
    )
    client.on('error', () => undefined)
    const responsePromise = once(client, 'unexpected-response')
    controller.abort()
    const [, response] = await responsePromise

    expect(response.statusCode).toBe(503)
    response.resume()
    await once(response, 'end')
  })
})
