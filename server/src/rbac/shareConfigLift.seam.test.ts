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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { WebSocketServer } from 'ws'
import * as A from '@automerge/automerge'
import { Repo, type PeerId } from '@automerge/automerge-repo'
import {
  NodeWSServerAdapter,
  BrowserWebSocketClientAdapter,
} from '@automerge/automerge-repo-network-websocket'

/**
 * The PRECONDITION of the rule "every denial must be paired with a lift".
 *
 * Every `return false` on the sync path must name the mechanism that lifts it,
 * because automerge-repo caches the verdict per (document, peer) and drops a
 * denied peer's changes. That mechanism is `Repo.shareConfigChanged()`, used by
 * `onWorkspaceIndexRepaired` and the `denyLedger` reconciliation.
 *
 * This suite pins WHEN that mechanism cannot work. `shareConfigChanged()` ->
 * `reevaluateDocumentShare()` iterates `#docSynchronizers`, then
 * `reevaluateSharePolicy()` iterates each one's `#peers`.
 * `CollectionSynchronizer.detach` — reached from `Repo.removeFromCache`, hence
 * from `releaseUnavailableDocument` on the projector's resolution-failure
 * path — removes every peer THEN deletes the synchronizer. A lift on a
 * detached document therefore walks nothing: it silently succeeds by doing
 * nothing. (Measured: the positive arm delivers in ~30 ms; the detached arms
 * never delivered.)
 *
 * Every negative case carries a LIVENESS WITNESS in the same window — a second,
 * allowed document that MUST arrive. Without it, an absence would only mean
 * "the machine was slow", and the test would pass against a dead server.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait for STATE, never for a duration (same reason as in
 *  `automergeRepoCompat.seam.test.ts`). Without this wait, `allowed.add()`
 *  can precede the policy consultation, the document is allowed from the
 *  start, and the test fails RED — so a timing bet would be a red flake, not
 *  a false green. The false-green case (dead socket) is covered by the
 *  liveness witness. */
async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition jamais atteinte')
    await sleep(10)
  }
}

interface ServerHandle {
  repo: Repo
  port: number
  close: () => Promise<void>
}

async function makeServer(
  access: (peerId: string, documentId: string) => Promise<boolean>,
): Promise<ServerHandle> {
  const http: Server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) =>
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)),
  )
  type WssParam = ConstructorParameters<typeof NodeWSServerAdapter>[0]
  const repo = new Repo({
    network: [new NodeWSServerAdapter(wss as unknown as WssParam)],
    // The server announces nothing and holds nothing: the import shape,
    // where the browser alone carries the bytes.
    shareConfig: { announce: async () => false, access },
  })
  await new Promise<void>((res) => http.listen(0, res))
  return {
    repo,
    port: (http.address() as { port: number }).port,
    close: async () => {
      wss.close()
      http.closeAllConnections?.()
      await new Promise<void>((res) => http.close(() => res()))
    },
  }
}

function makeClient(port: number): { repo: Repo; close: () => void } {
  const adapter = new BrowserWebSocketClientAdapter(`ws://localhost:${port}`)
  const repo = new Repo({ network: [adapter], sharePolicy: async () => true })
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

/** Read the server's copy WITHOUT creating a query. `findWithProgress` CREATES
 *  the query when absent, so using it to ask "is it there?" would resurrect
 *  the document and the probe would manufacture its own result. */
function serverMarker(repo: Repo, documentId: string): string | null {
  const handle = repo.handles[documentId]
  if (!handle) return null
  try {
    const doc = handle.doc() as { marker?: string } | undefined
    return doc?.marker ?? null
  } catch {
    return null
  }
}

/**
 * What a page RELOAD does implicitly: a new `Repo` has a new peer id, hence a
 * fresh sync state for every document. Doing that by hand is the ONLY thing
 * measured to recover a detached document.
 *
 * `syncAllPeers()` alone is not enough, counter-intuitively: `#sendSyncMessage`
 * calls `A.generateSyncMessage(doc, syncState)` then `if (!message) return`,
 * and the client's sync state still believes its first frame awaits a reply,
 * so it generates nothing. `addPeer` is public and fully replaces the
 * existing state, which is exactly what is needed.
 */
function clientResetsSyncState(clientRepo: Repo, documentId: string): void {
  const docSync = clientRepo.synchronizer.docSynchronizers[documentId as never]
  for (const peerId of clientRepo.synchronizer.peers) {
    docSync?.addPeer(peerId as PeerId, Promise.resolve(A.initSyncState()))
  }
}

async function pollMarker(repo: Repo, documentId: string, ms: number): Promise<string | null> {
  const deadline = Date.now() + ms
  for (;;) {
    const marker = serverMarker(repo, documentId)
    if (marker) return marker
    if (Date.now() > deadline) return null
    await sleep(20)
  }
}

describe('shareConfigChanged() — ce qu\'une levée peut et ne peut pas récupérer', () => {
  let previousSelective: string | undefined

  beforeEach(() => {
    // `AM_SELECTIVE_SYNC` is read from `globalThis.process.env` by
    // `CollectionSynchronizer.attach`, so it is PROCESS-GLOBAL — and both
    // `Repo`s in this file share the process. Setting it would also disable
    // the CLIENT's announce, and the denial under test would never happen.
    previousSelective = process.env.AM_SELECTIVE_SYNC
    delete process.env.AM_SELECTIVE_SYNC
  })

  afterEach(() => {
    if (previousSelective === undefined) delete process.env.AM_SELECTIVE_SYNC
    else process.env.AM_SELECTIVE_SYNC = previousSelective
  })

  it('LÈVE un refus : le pair refusé re-livre ses octets après shareConfigChanged()', async () => {
    const allowed = new Set<string>()
    // Denial witness: the policy WAS consulted for this document while
    // `allowed` was empty. This replaces a timing bet, and is the only thing
    // that distinguishes "denied then lifted" from "always allowed".
    const consulted = new Map<string, number>()
    const server = await makeServer(async (_peer, documentId) => {
      const id = String(documentId)
      consulted.set(id, (consulted.get(id) ?? 0) + 1)
      return allowed.has(id)
    })
    const client = makeClient(server.port)
    try {
      const handle = client.repo.create({ marker: 'from-client' })
      await handle.whenReady()
      const documentId = String(handle.documentId)

      await until(() => (consulted.get(documentId) ?? 0) >= 1)
      // The denial did happen: without this, an arm that was never denied
      // would pass as a successful lift.
      expect(serverMarker(server.repo, documentId)).toBeNull()

      allowed.add(documentId)
      server.repo.shareConfigChanged()

      expect(await pollMarker(server.repo, documentId, 5_000)).toBe('from-client')
    } finally {
      client.close()
      await server.close()
    }
  })

  it('NE LÈVE RIEN sur un document DÉTACHÉ — removeFromCache supprime le synchroniseur', async () => {
    const allowed = new Set<string>()
    // Denial witness — see the first arm.
    const consulted = new Map<string, number>()
    const server = await makeServer(async (_peer, documentId) => {
      const id = String(documentId)
      consulted.set(id, (consulted.get(id) ?? 0) + 1)
      return allowed.has(id)
    })
    const client = makeClient(server.port)
    try {
      const denied = client.repo.create({ marker: 'denied-then-detached' })
      await denied.whenReady()
      const deniedId = String(denied.documentId)

      await until(() => (consulted.get(deniedId) ?? 0) >= 1)
      expect(serverMarker(server.repo, deniedId)).toBeNull()

      // What `releaseUnavailableDocument` does on the projector's failure
      // path — and the projector only fails to resolve this document
      // BECAUSE the denial made it unresolvable.
      await server.repo.removeFromCache(denied.documentId)

      allowed.add(deniedId)
      server.repo.shareConfigChanged()

      // LIVENESS WITNESS, in the same window and on the same socket.
      const witness = client.repo.create({ marker: 'liveness-witness' })
      await witness.whenReady()
      allowed.add(String(witness.documentId))
      server.repo.shareConfigChanged()

      expect(await pollMarker(server.repo, String(witness.documentId), 5_000)).toBe(
        'liveness-witness',
      )
      // Delivery worked throughout the window; the detached one never arrived.
      expect(serverMarker(server.repo, deniedId)).toBeNull()
    } finally {
      client.close()
      await server.close()
    }
  })

  it('ne récupère TOUJOURS rien si le document est RÉ-ATTACHÉ avant la levée', async () => {
    const allowed = new Set<string>()
    // Denial witness — see the first arm.
    const consulted = new Map<string, number>()
    const server = await makeServer(async (_peer, documentId) => {
      const id = String(documentId)
      consulted.set(id, (consulted.get(id) ?? 0) + 1)
      return allowed.has(id)
    })
    const client = makeClient(server.port)
    try {
      const denied = client.repo.create({ marker: 'denied-detached-reattached' })
      await denied.whenReady()
      const deniedId = String(denied.documentId)

      await until(() => (consulted.get(deniedId) ?? 0) >= 1)
      expect(serverMarker(server.repo, deniedId)).toBeNull()

      await server.repo.removeFromCache(denied.documentId)
      // `documentRepoState` calls `findWithProgress`, which CREATES an absent
      // query, so the projector's NEXT attempt re-creates what it just
      // detached. The synchronizer is reborn — without the peer that holds
      // the bytes, and `reevaluateSharePolicy` iterates `#peers`.
      server.repo.findWithProgress(denied.url)
      expect(server.repo.handles[deniedId]).toBeTruthy()

      allowed.add(deniedId)
      server.repo.shareConfigChanged()

      const witness = client.repo.create({ marker: 'liveness-witness' })
      await witness.whenReady()
      allowed.add(String(witness.documentId))
      server.repo.shareConfigChanged()

      expect(await pollMarker(server.repo, String(witness.documentId), 5_000)).toBe(
        'liveness-witness',
      )
      expect(serverMarker(server.repo, deniedId)).toBeNull()
    } finally {
      client.close()
      await server.close()
    }
  })

  it('mais le CLIENT récupère le document détaché en réinitialisant son état de sync', async () => {
    const allowed = new Set<string>()
    const consulted = new Map<string, number>()
    const server = await makeServer(async (_peer, documentId) => {
      const id = String(documentId)
      consulted.set(id, (consulted.get(id) ?? 0) + 1)
      return allowed.has(id)
    })
    const client = makeClient(server.port)
    try {
      const denied = client.repo.create({ marker: 'recovered-by-client' })
      await denied.whenReady()
      const deniedId = String(denied.documentId)

      await until(() => (consulted.get(deniedId) ?? 0) >= 1)
      expect(serverMarker(server.repo, deniedId)).toBeNull()

      await server.repo.removeFromCache(denied.documentId)

      // The lift alone is inert here (previous case); the client-side sync
      // state reset is what makes it effective.
      allowed.add(deniedId)
      server.repo.shareConfigChanged()
      clientResetsSyncState(client.repo, deniedId)

      expect(await pollMarker(server.repo, deniedId, 5_000)).toBe('recovered-by-client')
    } finally {
      client.close()
      await server.close()
    }
  })

  it('et cette reprise NE CONTOURNE PAS un refus toujours debout', async () => {
    const allowed = new Set<string>()
    const consulted = new Map<string, number>()
    const server = await makeServer(async (_peer, documentId) => {
      const id = String(documentId)
      consulted.set(id, (consulted.get(id) ?? 0) + 1)
      return allowed.has(id)
    })
    const client = makeClient(server.port)
    try {
      const denied = client.repo.create({ marker: 'must-stay-denied' })
      await denied.whenReady()
      const deniedId = String(denied.documentId)

      await until(() => (consulted.get(deniedId) ?? 0) >= 1)
      expect(serverMarker(server.repo, deniedId)).toBeNull()

      await server.repo.removeFromCache(denied.documentId)

      // The denial is NEVER lifted: `allowed` never receives `deniedId`.
      clientResetsSyncState(client.repo, deniedId)

      // Without this witness, "nothing arrived" would not prove the gate held:
      // a dead socket would give the same green. This document is allowed.
      const witness = client.repo.create({ marker: 'liveness-witness' })
      await witness.whenReady()
      allowed.add(String(witness.documentId))
      server.repo.shareConfigChanged()

      expect(await pollMarker(server.repo, String(witness.documentId), 5_000)).toBe(
        'liveness-witness',
      )
      expect(serverMarker(server.repo, deniedId)).toBeNull()
    } finally {
      client.close()
      await server.close()
    }
  })
})
