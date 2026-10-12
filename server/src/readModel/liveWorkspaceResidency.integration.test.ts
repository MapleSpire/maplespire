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
import { WebSocketServer } from 'ws'
import { Repo, type AutomergeUrl, type PeerId } from '@automerge/automerge-repo'
import { NodeWSServerAdapter, BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { AuthenticatedWSServerAdapter } from '../automergeServer.js'
import { createSyncWriteGate } from '../syncWriteGate.js'
import { LiveWorkspaceResidency, type ResidencyFleet } from './liveWorkspaceResidency.js'
import type { WorkspaceKey } from './projector.js'

/**
 * The residency trigger, over REAL WebSockets: a peer that merely CONNECTS and
 * syncs a document of a workspace this cell owns makes the fleet ensure that
 * workspace's projector, before any read-model route is asked and before the
 * peer writes anything; a write on the same workspace finds it resident and
 * asks nothing more; a document of a workspace this cell does NOT own is still
 * SERVED (the ownership gate, like every sync write gate, drops only frames
 * that carry changes — reads are what View means), its write is dropped, and
 * neither ever reaches the fleet.
 *
 * The adapter and the gate are the production classes; the wiring of the gate's
 * `canWrite` to `noteOwnedActivity` is the shape `automergeServer.ts` uses,
 * with the placement (`resolveDocumentPlacement`) and the ownership
 * (`SyncCellOwnership.owns`) stubbed per document. The production wiring itself
 * is exercised on the two-partition bench.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(read: () => T, ok: (value: T) => boolean, ms = 5_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const value = read()
    if (ok(value) || Date.now() - start > ms) return value
    await sleep(25)
  }
}

interface DocShape { title: string }

const OWNED: WorkspaceKey = { landscapeId: 'ls-owned', versionId: 'v1' }
const FOREIGN: WorkspaceKey = { landscapeId: 'ls-foreign', versionId: 'v1' }

describe('live workspace residency — over real WebSockets', () => {
  it('a connecting peer on an OWNED workspace makes the fleet ensure it once; a write finds it resident; a foreign document is read but its write is dropped, and it never reaches the fleet', async () => {
    const http: Server = createServer()
    const wss = new WebSocketServer({ noServer: true })
    http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)))
    type WssParam = ConstructorParameters<typeof NodeWSServerAdapter>[0]
    const adapter = new AuthenticatedWSServerAdapter(wss as unknown as WssParam)

    const placement = new Map<string, WorkspaceKey>()
    const owns = (workspace: WorkspaceKey) => workspace.landscapeId === OWNED.landscapeId
    const resident = new Set<string>()
    const ensured: string[] = []
    const touched: string[] = []
    // The fake cold build is GATED by the test, not timed: with a 10 ms sleep
    // the second owned frame lands only a few ms after the first, so a
    // "two ensures" regression would be caught by coincidence and missed on a
    // loaded machine.
    let releaseColdBuild: () => void = () => undefined
    const coldBuildReleased = new Promise<void>((resolve) => { releaseColdBuild = resolve })
    const fleet: ResidencyFleet = {
      isResident: (key) => resident.has(key.landscapeId),
      ensure: async (key) => {
        ensured.push(key.landscapeId)
        await coldBuildReleased // frames keep arriving while the build runs
        resident.add(key.landscapeId)
        return true
      },
      size: () => resident.size,
      capacity: () => 8,
      touch: (key) => { touched.push(key.landscapeId); return resident.has(key.landscapeId) },
    }
    const residency = new LiveWorkspaceResidency({ fleet: () => fleet, isExpectedRefusal: () => false })
    const denied: string[] = []
    // The production shape (automergeServer.ts, ownership gate): placement, then
    // ownership; an owned frame is reported BEFORE the verdict is returned.
    adapter.ownershipGate = createSyncWriteGate({
      stage: () => 'on',
      canWrite: async (_peerId, documentId) => {
        const workspace = placement.get(documentId) ?? null
        if (workspace && owns(workspace)) residency.noteOwnedActivity(workspace)
        return workspace !== null && owns(workspace)
      },
      onDenied: ({ documentId }) => denied.push(documentId),
    })
    const serverRepo = new Repo({ network: [adapter], sharePolicy: async () => true })
    await new Promise<void>((resolve) => http.listen(0, resolve))
    const port = (http.address() as { port: number }).port

    const ownedDoc = serverRepo.create<DocShape>({ title: 'owned' })
    const foreignDoc = serverRepo.create<DocShape>({ title: 'foreign' })
    placement.set(String(ownedDoc.documentId), OWNED)
    placement.set(String(foreignDoc.documentId), FOREIGN)

    const clientAdapter = new BrowserWebSocketClientAdapter(`ws://localhost:${port}`)
    const client = new Repo({ network: [clientAdapter], sharePolicy: async () => true, peerId: 'live-peer' as PeerId })
    try {
      // CONNECT and sync — no write yet. The handshake frames are the trigger,
      // and the fake cold build they start stays open until this test says so.
      const handle = await client.find<DocShape>(ownedDoc.url as AutomergeUrl)
      expect(handle.doc()?.title).toBe('owned')
      await until(() => ensured.length, (n) => n >= 1)
      expect(ensured).toEqual(['ls-owned'])
      expect(resident.has('ls-owned')).toBe(false)

      // A WRITE while the build is still running: the frame is DELIVERED (the
      // server doc changes — asserted, not assumed), reported, throttled, and
      // does not start a second build. This catches a removed throttle
      // deterministically: with the build gated, the write frame is guaranteed
      // to land inside the window.
      handle.change((doc) => { doc.title = 'owned-edited' })
      await until(() => ownedDoc.doc()?.title, (title) => title === 'owned-edited')
      expect(ownedDoc.doc()?.title).toBe('owned-edited')
      expect(residency.snapshot().activity).toBeGreaterThanOrEqual(2)
      expect(residency.snapshot().throttled).toBeGreaterThanOrEqual(1)
      expect(ensured).toEqual(['ls-owned'])

      // The build completes: resident. The next write is TOUCHED (the LRU sees
      // the write as a use) and asks for nothing more.
      releaseColdBuild()
      await residency.pending(OWNED)
      await until(() => resident.has('ls-owned'), (yes) => yes)
      expect(resident.has('ls-owned')).toBe(true)
      const touchedBefore = touched.length
      handle.change((doc) => { doc.title = 'owned-edited-again' })
      await until(() => ownedDoc.doc()?.title, (title) => title === 'owned-edited-again')
      expect(ownedDoc.doc()?.title).toBe('owned-edited-again')
      expect(touched.length).toBeGreaterThan(touchedBefore)
      expect(touched.every((landscape) => landscape === 'ls-owned')).toBe(true)
      expect(ensured).toEqual(['ls-owned'])

      // A FOREIGN document: its READ passes the gate (only change-carrying
      // frames are dropped), its WRITE is dropped, and neither frame reaches
      // the fleet: the note is made only for an OWNED workspace.
      const foreign = await client.find<DocShape>(foreignDoc.url as AutomergeUrl)
      expect(foreign.doc()?.title).toBe('foreign')
      foreign.change((doc) => { doc.title = 'foreign-hacked' })
      await until(() => denied.length, (n) => n >= 1)
      expect(denied).toContain(String(foreignDoc.documentId))
      await sleep(200)
      expect(foreignDoc.doc()?.title).toBe('foreign')
      expect(ensured).toEqual(['ls-owned'])
      expect(residency.snapshot()).toMatchObject({ ensuresRequested: 1, ensured: 1 })
    } finally {
      try { clientAdapter.disconnect() } catch { /* ignore */ }
      await client.shutdown().catch(() => undefined)
      await serverRepo.shutdown().catch(() => undefined)
      wss.close()
      http.closeAllConnections?.()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    }
  }, 30_000)
})
