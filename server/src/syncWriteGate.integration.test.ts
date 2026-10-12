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

import { describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { WebSocketServer } from 'ws'
import { Repo, type AutomergeUrl, type PeerId } from '@automerge/automerge-repo'
import { NodeWSServerAdapter, BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { AuthenticatedWSServerAdapter } from './automergeServer.js'
import { createSyncWriteGate } from './syncWriteGate.js'

/**
 * END-TO-END proof of the sync write enforcement over real WebSockets: two
 * genuine client repos (a "viewer" and a "writer", distinguished by peer id)
 * sync against a server repo running the REAL AuthenticatedWSServerAdapter +
 * syncWriteGate wiring from automergeServer.ts. This is the browser-equivalent
 * attack path — a client that ignores its read-only UI and mutates the doc
 * directly — and must show:
 *
 *   1. the viewer still READS the doc (and receives the writer's later edits);
 *   2. the viewer's own change is never applied server-side, never persisted,
 *      and never relayed to the writer;
 *   3. the writer's edits flow normally end-to-end.
 *
 * No Postgres needed: the RBAC verdict is stubbed per peer id; the DB-backed
 * verdict itself is covered in rbac/docScope.write.test.ts.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (ok(v) || Date.now() - start > ms) return v
    await sleep(25)
  }
}

interface DocShape {
  title: string
  hacked?: string
}

async function makeGatedServer(): Promise<{ repo: Repo; port: number; close: () => Promise<void> }> {
  const http: Server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)))
  type WssParam = ConstructorParameters<typeof NodeWSServerAdapter>[0]
  const adapter = new AuthenticatedWSServerAdapter(wss as unknown as WssParam)
  // Same shape as automergeServer.ts's production wiring; only the RBAC lookup
  // is stubbed (peer ids starting with "writer" hold the write grant).
  adapter.writeGate = createSyncWriteGate({
    stage: () => 'on',
    canWrite: async (peerId) => peerId.startsWith('writer'),
  })
  const repo = new Repo({ network: [adapter], sharePolicy: async () => true })
  await new Promise<void>((res) => http.listen(0, res))
  const port = (http.address() as { port: number }).port
  return {
    repo,
    port,
    close: async () => {
      wss.close()
      http.closeAllConnections?.()
      await new Promise<void>((res) => http.close(() => res()))
    },
  }
}

function makeClient(port: number, peerId: string): { repo: Repo; close: () => void } {
  const adapter = new BrowserWebSocketClientAdapter(`ws://localhost:${port}`)
  const repo = new Repo({ network: [adapter], sharePolicy: async () => true, peerId: peerId as PeerId })
  return {
    repo,
    close: () => {
      try {
        adapter.disconnect()
      } catch {
        /* ignore */
      }
    },
  }
}

describe('sync write gate — end-to-end over real WebSockets', () => {
  it('serves one explicitly requested document to 50 simultaneous cold peers', async () => {
    const http: Server = createServer()
    const wss = new WebSocketServer({ noServer: true })
    http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)))
    const serverAdapter = new NodeWSServerAdapter(wss)
    const serverRepo = new Repo({
      network: [serverAdapter],
      shareConfig: {
        announce: async () => false,
        access: async () => true,
      },
    })
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as { port: number }).port
    const serverHandle = serverRepo.create<DocShape>({ title: 'fanout-ready' })
    const clients = Array.from({ length: 50 }, (_, index) => makeClient(port, `fanout-${index}`))
    try {
      const handles = await Promise.all(clients.map(({ repo }) => repo.find<DocShape>(serverHandle.url)))
      expect(handles).toHaveLength(50)
      expect(handles.every((handle) => handle.doc()?.title === 'fanout-ready')).toBe(true)
      expect(serverRepo.synchronizer.metrics()[serverHandle.documentId]?.peers).toHaveLength(50)
    } finally {
      for (const client of clients) client.close()
      await Promise.all(clients.map(({ repo }) => repo.shutdown().catch(() => undefined)))
      await serverRepo.shutdown().catch(() => undefined)
      wss.close()
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  }, 30_000)

  it('binds a peer identity before Repo evaluates selective access', async () => {
    const http: Server = createServer()
    const wss = new WebSocketServer({ noServer: true })
    http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)))
    type WssParam = ConstructorParameters<typeof NodeWSServerAdapter>[0]
    const knownPeers = new Set<string>()
    const adapter = new AuthenticatedWSServerAdapter(wss as unknown as WssParam)
    adapter.setPeerCandidateBinder((peerId) => knownPeers.add(peerId))
    const serverRepo = new Repo({
      network: [adapter],
      shareConfig: {
        announce: async () => false,
        access: async (peerId) => {
          await sleep(5)
          return peerId !== undefined && knownPeers.has(peerId)
        },
      },
    })
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as { port: number }).port
    const serverHandle = serverRepo.create<DocShape>({ title: 'identity-ready' })
    const client = makeClient(port, 'bound-before-policy')
    try {
      const handle = await client.repo.find<DocShape>(serverHandle.url)
      expect(handle.doc()?.title).toBe('identity-ready')
      expect(knownPeers).toContain('bound-before-policy')
    } finally {
      client.close()
      await client.repo.shutdown().catch(() => undefined)
      await serverRepo.shutdown().catch(() => undefined)
      wss.close()
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  }, 30_000)

  it('viewer reads but cannot persist/relay; writer edits flow; viewer keeps receiving', async () => {
    const server = await makeGatedServer()
    const serverHandle = server.repo.create<DocShape>({ title: 'v1' })
    await serverHandle.whenReady()
    const url = serverHandle.url as AutomergeUrl

    const viewer = makeClient(server.port, 'viewer-1')
    const writer = makeClient(server.port, 'writer-1')
    try {
      // 1. Both clients can READ the doc.
      const viewerHandle = await viewer.repo.find<DocShape>(url)
      await viewerHandle.whenReady()
      expect(viewerHandle.doc()?.title).toBe('v1')
      const writerHandle = await writer.repo.find<DocShape>(url)
      await writerHandle.whenReady()
      expect(writerHandle.doc()?.title).toBe('v1')

      // 2. The viewer tampers with the doc locally (a client that bypassed its
      //    read-only UI) — the change must never reach the server or the writer.
      viewerHandle.change((d) => {
        d.hacked = 'by-viewer'
      })
      expect(viewerHandle.doc()?.hacked).toBe('by-viewer') // local echo exists…
      await sleep(700) // …give the sync every chance to (wrongly) propagate
      expect(serverHandle.doc()?.hacked).toBeUndefined()
      expect(writerHandle.doc()?.hacked).toBeUndefined()

      // 3. The writer's edit flows end-to-end…
      writerHandle.change((d) => {
        d.title = 'v2-by-writer'
      })
      const serverTitle = await until(() => serverHandle.doc()?.title, (t) => t === 'v2-by-writer')
      expect(serverTitle).toBe('v2-by-writer')

      // 4. …and the viewer still RECEIVES it (read path alive after the drop).
      const viewerTitle = await until(() => viewerHandle.doc()?.title, (t) => t === 'v2-by-writer')
      expect(viewerTitle).toBe('v2-by-writer')

      // 5. Even after full convergence, the tampered field exists nowhere but
      //    the viewer's own local copy.
      await sleep(400)
      expect(serverHandle.doc()?.hacked).toBeUndefined()
      expect(writerHandle.doc()?.hacked).toBeUndefined()
    } finally {
      viewer.close()
      writer.close()
      await server.close()
    }
  }, 30000)

  it("without a write gate installed (AUTH=off wiring) the same tamper DOES propagate — proving the gate is what blocks it", async () => {
    const http: Server = createServer()
    const wss = new WebSocketServer({ noServer: true })
    http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)))
    type WssParam = ConstructorParameters<typeof NodeWSServerAdapter>[0]
    const adapter = new AuthenticatedWSServerAdapter(wss as unknown as WssParam) // writeGate stays null
    const repo = new Repo({ network: [adapter], sharePolicy: async () => true })
    await new Promise<void>((res) => http.listen(0, res))
    const port = (http.address() as { port: number }).port

    const serverHandle = repo.create<DocShape>({ title: 'open' })
    await serverHandle.whenReady()
    const client = makeClient(port, 'viewer-2')
    try {
      const clientHandle = await client.repo.find<DocShape>(serverHandle.url as AutomergeUrl)
      await clientHandle.whenReady()
      clientHandle.change((d) => {
        d.hacked = 'legacy-open-mode'
      })
      const propagated = await until(() => serverHandle.doc()?.hacked, (v) => v === 'legacy-open-mode')
      expect(propagated).toBe('legacy-open-mode') // AUTH=off stays byte-identical
    } finally {
      client.close()
      wss.close()
      http.closeAllConnections?.()
      await new Promise<void>((res) => http.close(() => res()))
    }
  }, 30000)
})
