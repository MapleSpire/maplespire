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
import { getHeads } from '@automerge/automerge'
import { Repo, type AutomergeUrl, type PeerId } from '@automerge/automerge-repo'
import { NodeWSServerAdapter, BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import type pg from 'pg'
import { AuthenticatedWSServerAdapter } from './automergeServer.js'
import { createSyncWriteGate, type SyncWriteGate } from './syncWriteGate.js'
import { buildBaselineWriteFence } from './rbac/docScope.js'

/**
 * END-TO-END proof of the BASELINE WRITE FENCE over
 * real WebSockets — the syncWriteGate.integration.test.ts harness pointed at
 * the fence instead of RBAC. The attack path is the one the fence exists for:
 * a stale classic client (no VITE flags, no auth stage — the adapter here has
 * NO writeGate, i.e. the AUTH=off wiring) reconciling its windowed store into
 * a promoted workspace's frozen baseline shards. It must show:
 *
 *   1. a fenced base-shard write is refused AND the client's ack never
 *      arrives: the server never applies the change, never announces heads
 *      containing it, so the client stays DIVERGENT on that doc — the sync
 *      badge's honest "Enregistrement…" — even after later traffic on the
 *      same socket has round-tripped (so it is refusal, not lag);
 *   2. write-head (`registry-shard`) and `diagram` writes PASS the fence on
 *      the same static workspace — the writes sparse drafts perform;
 *   3. the fence never cuts READS: a server-side baseline change still
 *      reaches the fenced client;
 *   4. the refusal is VISIBLE server-side (onDenied fired) — no silent catch.
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

/** In-memory stand-in for the two static tables. The fence's SQL is answered
 * by statement shape; the exact-SQL half is pinned against real Postgres in
 * rbac/baselineWriteFence.test.ts. */
function staticTablesPool(documents: Map<string, string>): pg.Pool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (/FROM read_model_static_documents/.test(sql)) {
        const kind = documents.get(String(params?.[0]))
        return { rows: kind ? [{ kind }] : [], rowCount: kind ? 1 : 0 }
      }
      if (/read_model_static_workspaces/.test(sql)) {
        return { rows: [{ present: true }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    },
  } as unknown as pg.Pool
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

describe('baseline write fence — end-to-end over real WebSockets', () => {
  it('a fenced base-shard write is refused and never acked; write-head and diagram writes pass; reads stay alive', async () => {
    const http: Server = createServer()
    const wss = new WebSocketServer({ noServer: true })
    http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)))
    type WssParam = ConstructorParameters<typeof NodeWSServerAdapter>[0]
    const adapter = new AuthenticatedWSServerAdapter(wss as unknown as WssParam)

    // The static allow-list rows, keyed later once the docs exist.
    const staticDocs = new Map<string, string>()
    const denied: Array<{ peerId: string; documentId: string }> = []
    // NOTE: no writeGate and no ownershipGate — the AUTH=off wiring. The fence
    // alone must hold, exactly as automergeServer.ts wires it (stage 'on').
    adapter.baselineWriteFence = createSyncWriteGate({
      stage: () => 'on',
      canWrite: buildBaselineWriteFence(staticTablesPool(staticDocs)),
      onDenied: ({ peerId, documentId }) => denied.push({ peerId, documentId }),
    })
    const serverRepo = new Repo({ network: [adapter], sharePolicy: async () => true })
    await new Promise<void>((res) => http.listen(0, res))
    const port = (http.address() as { port: number }).port

    const baseHandle = serverRepo.create<DocShape>({ title: 'frozen-base' })
    const headHandle = serverRepo.create<DocShape>({ title: 'write-head' })
    const diagramHandle = serverRepo.create<DocShape>({ title: 'diagram' })
    staticDocs.set(String(baseHandle.documentId), 'object-base')
    staticDocs.set(String(headHandle.documentId), 'registry-shard')
    staticDocs.set(String(diagramHandle.documentId), 'diagram')

    const client = makeClient(port, 'stale-classic-tab')
    try {
      const clientBase = await client.repo.find<DocShape>(baseHandle.url as AutomergeUrl)
      await clientBase.whenReady()
      expect(clientBase.doc()?.title).toBe('frozen-base') // read path in
      const clientHead = await client.repo.find<DocShape>(headHandle.url as AutomergeUrl)
      await clientHead.whenReady()
      const clientDiagram = await client.repo.find<DocShape>(diagramHandle.url as AutomergeUrl)
      await clientDiagram.whenReady()

      const serverBaseHeadsBefore = getHeads(baseHandle.doc()!)

      // 1. The fenced write goes out FIRST on the socket…
      clientBase.change((d) => {
        d.hacked = 'windowed-store-reconcile'
      })
      // 2. …then the legitimate writes the fence must NOT break.
      clientHead.change((d) => {
        d.title = 'head-v2'
      })
      clientDiagram.change((d) => {
        d.title = 'diagram-v2'
      })

      // The controls round-trip — proof the socket processed messages QUEUED
      // AFTER the fenced one, so what follows is refusal, not lag.
      const headTitle = await until(() => headHandle.doc()?.title, (t) => t === 'head-v2')
      expect(headTitle).toBe('head-v2')
      const diagramTitle = await until(() => diagramHandle.doc()?.title, (t) => t === 'diagram-v2')
      expect(diagramTitle).toBe('diagram-v2')
      await sleep(500) // …and every further chance to (wrongly) apply it

      // Refused: never applied, never persisted, heads never advanced.
      expect(baseHandle.doc()?.hacked).toBeUndefined()
      expect(getHeads(baseHandle.doc()!)).toEqual(serverBaseHeadsBefore)
      // The ack never arrives: the client keeps its local change (the echo)
      // while the server never announces heads containing it — the client
      // stays divergent, which is exactly what keeps its badge on
      // "Enregistrement…" instead of a lying "Synchronisé".
      expect(clientBase.doc()?.hacked).toBe('windowed-store-reconcile')
      expect(getHeads(clientBase.doc()!)).not.toEqual(getHeads(baseHandle.doc()!))
      // The refusal is visible server-side — never swallowed.
      expect(denied.some((d) => d.documentId === String(baseHandle.documentId))).toBe(true)
      expect(denied.some((d) => d.documentId === String(headHandle.documentId))).toBe(false)
      expect(denied.some((d) => d.documentId === String(diagramHandle.documentId))).toBe(false)

      // 3. Reads stay alive THROUGH the fence: a server-side baseline change
      //    (compaction, repair — server-owned writers) reaches the client.
      baseHandle.change((d) => {
        d.title = 'frozen-base-v2'
      })
      const clientTitle = await until(() => clientBase.doc()?.title, (t) => t === 'frozen-base-v2')
      expect(clientTitle).toBe('frozen-base-v2')
    } finally {
      client.close()
      await client.repo.shutdown().catch(() => undefined)
      await serverRepo.shutdown().catch(() => undefined)
      wss.close()
      http.closeAllConnections?.()
      await new Promise<void>((res) => http.close(() => res()))
    }
  }, 30_000)
})

describe('write-gate chain order — ownership → fence → RBAC (N7)', () => {
  it('runs the three gates in that order and delivers once', () => {
    // The order only affects AUDIT ATTRIBUTION, not the verdict (each gate
    // drops independently): the fence sits BEFORE the RBAC write gate so a
    // fenced-baseline drop — a server policy about the DOCUMENT — is never
    // also recorded as a per-user RBAC denial, and ownership sits first so a
    // non-owning cell never speaks for either.
    const wss = new WebSocketServer({ noServer: true })
    type WssParam = ConstructorParameters<typeof NodeWSServerAdapter>[0]
    const adapter = new AuthenticatedWSServerAdapter(wss as unknown as WssParam)
    const order: string[] = []
    const gate = (name: string): SyncWriteGate => ({
      process: (_message, _socketKey, deliver) => {
        order.push(name)
        deliver()
      },
    })
    adapter.ownershipGate = gate('ownership')
    adapter.baselineWriteFence = gate('fence')
    adapter.writeGate = gate('rbac')

    let delivered = 0
    adapter.on('message', () => { delivered += 1 })
    adapter.emit('message', {
      type: 'sync', senderId: 'peer-1', targetId: 'server', documentId: 'doc-1', data: new Uint8Array(),
    })

    expect(order).toEqual(['ownership', 'fence', 'rbac'])
    expect(delivered).toBe(1)
    wss.close()
  })
})
