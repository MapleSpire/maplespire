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
import { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { Repo, type AutomergeUrl, type DocHandleEphemeralMessagePayload, type PeerId } from '@automerge/automerge-repo'
import { BrowserWebSocketClientAdapter, NodeWSServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { AuthenticatedWSServerAdapter } from './automergeServer.js'
import { createDiagramPresenceGate, DIAGRAM_PRESENCE_CHANNEL } from './diagramPresenceGate.js'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function client(port: number, peerId: string) {
  const adapter = new BrowserWebSocketClientAdapter(`ws://localhost:${port}`)
  const repo = new Repo({ network: [adapter], sharePolicy: async () => true, peerId: peerId as PeerId })
  return { repo, close: () => adapter.disconnect() }
}

describe('diagram presence gate — real WebSocket relay', () => {
  it('relays only a sanitized cursor on an authorized DiagramDoc', async () => {
    const http: Server = createServer()
    const wss = new WebSocketServer({ noServer: true })
    http.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
    })
    type WssParam = ConstructorParameters<typeof NodeWSServerAdapter>[0]
    const adapter = new AuthenticatedWSServerAdapter(wss as unknown as WssParam)
    let deniedDocumentId = ''
    adapter.presenceGate = createDiagramPresenceGate({
      canRead: async (_peerId, documentId) => documentId !== deniedDocumentId,
      identityForPeer: async () => ({ participantId: 'p_0123456789abcdef', firstName: 'Alice', initials: 'A' }),
    })
    const serverRepo = new Repo({ network: [adapter], sharePolicy: async () => true })
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as { port: number }).port
    const allowedServerHandle = serverRepo.create({ diagram: 'allowed' })
    const deniedServerHandle = serverRepo.create({ diagram: 'denied' })
    deniedDocumentId = deniedServerHandle.documentId
    const alice = client(port, 'alice-peer')
    const bob = client(port, 'bob-peer')

    try {
      const [aliceAllowed, bobAllowed, aliceDenied, bobDenied] = await Promise.all([
        alice.repo.find(allowedServerHandle.url as AutomergeUrl),
        bob.repo.find(allowedServerHandle.url as AutomergeUrl),
        alice.repo.find(deniedServerHandle.url as AutomergeUrl),
        bob.repo.find(deniedServerHandle.url as AutomergeUrl),
      ])
      await Promise.all([aliceAllowed.whenReady(), bobAllowed.whenReady(), aliceDenied.whenReady(), bobDenied.whenReady()])

      const received = new Promise<unknown>((resolve) => {
        bobAllowed.once('ephemeral-message', ({ message }: DocHandleEphemeralMessagePayload<{ diagram: string }>) => resolve(message))
      })
      aliceAllowed.broadcast({
        channel: DIAGRAM_PRESENCE_CHANNEL,
        version: 1,
        kind: 'cursor',
        sequence: 1,
        cursor: { x: 42, y: 84, view: '2d', visible: true },
        participant: { participantId: 'p_badbadbadbadbadb', firstName: 'Mallory', initials: 'M' },
      })
      await expect(received).resolves.toEqual({
        channel: DIAGRAM_PRESENCE_CHANNEL,
        version: 1,
        kind: 'cursor',
        sequence: 1,
        cursor: { x: 42, y: 84, view: '2d', visible: true },
        participant: { participantId: 'p_0123456789abcdef', firstName: 'Alice', initials: 'A' },
      })

      let deniedDelivered = false
      bobDenied.on('ephemeral-message', () => { deniedDelivered = true })
      aliceDenied.broadcast({
        channel: DIAGRAM_PRESENCE_CHANNEL,
        version: 1,
        kind: 'cursor',
        sequence: 1,
        cursor: { x: 1, y: 1, view: '2d', visible: true },
      })
      await sleep(250)
      expect(deniedDelivered).toBe(false)
    } finally {
      alice.close()
      bob.close()
      await Promise.all([
        alice.repo.shutdown().catch(() => undefined),
        bob.repo.shutdown().catch(() => undefined),
        serverRepo.shutdown().catch(() => undefined),
      ])
      wss.close()
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  }, 30_000)
})
