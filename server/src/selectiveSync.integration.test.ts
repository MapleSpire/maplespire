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
import { Repo, type AutomergeUrl, type DocHandle, type DocumentId } from '@automerge/automerge-repo'
import { NodeWSServerAdapter, BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { createSelectiveSync, type ShareConfig } from './selectiveSync.js'

/**
 * Regression guard for selective Automerge sync (the boot fix). Two real repos over
 * a loopback WebSocket prove that announcing only the core docs (a) stops the
 * proactive flood yet (b) still serves any doc on explicit request, and (c) keeps
 * live edits flowing on an open doc. No Postgres needed (pure sync behaviour).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(fn: () => T, ok: (v: T) => boolean, ms = 4000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (ok(v) || Date.now() - start > ms) return v
    await sleep(25)
  }
}

interface ServerHandle {
  repo: Repo
  port: number
  close: () => Promise<void>
}

/** Spin up an Automerge sync server over a loopback WebSocket with the given share
 * behaviour (selective shareConfig OR the legacy share-everything sharePolicy). */
async function makeServer(opts: { shareConfig?: ShareConfig; floodAll?: boolean }): Promise<ServerHandle> {
  const http: Server = createServer()
  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)))
  type WssParam = ConstructorParameters<typeof NodeWSServerAdapter>[0]
  const repo = new Repo({
    network: [new NodeWSServerAdapter(wss as unknown as WssParam)],
    ...(opts.floodAll ? { sharePolicy: async () => true } : { shareConfig: opts.shareConfig }),
  })
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

function makeClient(port: number, shareConfig?: ShareConfig): { repo: Repo; close: () => void } {
  const adapter = new BrowserWebSocketClientAdapter(`ws://localhost:${port}`)
  const repo = new Repo({
    network: [adapter],
    ...(shareConfig ? { shareConfig } : { sharePolicy: async () => true }),
  })
  return { repo, close: () => { try { adapter.disconnect() } catch { /* ignore */ } } }
}

describe('createSelectiveSync — core doc-id derivation', () => {
  it('marks root + meta + registry shards as core, but NOT the monolith or object shards', async () => {
    const repo = new Repo({})
    const meta = repo.create({ objectShardUrls: [], connectionShardUrls: [], groups: {} })
    const shardA = repo.create({ diagrams: {} })
    const shardB = repo.create({ diagrams: {} })
    const objShard = repo.create({ objects: {} }) // an OBJECT shard — must NOT be core
    const monolith = repo.create({ objects: {} }) // the monolithic ModelDoc — must NOT be core
    const root = repo.create({ modelUrl: monolith.url, modelMetaUrl: meta.url, shardUrls: [shardA.url, shardB.url] })
    await Promise.all([meta, shardA, shardB, objShard, monolith, root].map((h) => h.whenReady()))

    const sel = createSelectiveSync(() => root)
    sel.refresh()
    const core = new Set(sel.coreIds())
    expect(core.has(String(root.documentId))).toBe(true)
    expect(core.has(String(meta.documentId))).toBe(true)
    expect(core.has(String(shardA.documentId))).toBe(true)
    expect(core.has(String(shardB.documentId))).toBe(true)
    expect(core.has(String(objShard.documentId))).toBe(false) // object shards are on-demand
    expect(core.has(String(monolith.documentId))).toBe(false) // monolith is on-demand (not pushed)
    // announce gate agrees with the set; access is always open.
    await expect(sel.shareConfig.announce('peer', String(shardA.documentId))).resolves.toBe(true)
    await expect(sel.shareConfig.announce('peer', String(objShard.documentId))).resolves.toBe(false)
    await expect(sel.shareConfig.announce('peer', undefined)).resolves.toBe(false) // peer-level
    await expect(sel.shareConfig.access('peer', String(objShard.documentId))).resolves.toBe(true)

    // A static workspace pins only its tiny current write-head. Rotation must
    // remove the previous head so historical overlay segments stay lazy.
    expect(sel.setPinnedCore('land/version:object', String(objShard.documentId))).toBeUndefined()
    await expect(sel.shareConfig.announce('peer', String(objShard.documentId))).resolves.toBe(true)
    const nextHead = repo.create({ objects: {} }); await nextHead.whenReady()
    expect(sel.setPinnedCore('land/version:object', String(nextHead.documentId)))
      .toBe(String(objShard.documentId))
    await expect(sel.shareConfig.announce('peer', String(objShard.documentId))).resolves.toBe(false)
    await expect(sel.shareConfig.announce('peer', String(nextHead.documentId))).resolves.toBe(true)
    expect(sel.setPinnedCore('land/version:object')).toBe(String(nextHead.documentId))
    await expect(sel.shareConfig.announce('peer', String(nextHead.documentId))).resolves.toBe(false)
  })

  it('refreshes the core set when the root gains a shard / modelMetaUrl', async () => {
    const repo = new Repo({})
    const meta = repo.create({ groups: {} })
    const newShard = repo.create({ diagrams: {} })
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    await Promise.all([meta, newShard, root].map((h) => h.whenReady()))
    const sel = createSelectiveSync(() => root)
    sel.refresh()
    expect(new Set(sel.coreIds()).has(String(meta.documentId))).toBe(false)
    root.change((r: { modelMetaUrl?: string; shardUrls: string[] }) => {
      r.modelMetaUrl = meta.url
      r.shardUrls.push(newShard.url)
    })
    sel.refresh()
    const core = new Set(sel.coreIds())
    expect(core.has(String(meta.documentId))).toBe(true)
    expect(core.has(String(newShard.documentId))).toBe(true)
  })
})

describe('selective sync over a WebSocket', () => {
  it('FLOOD (legacy sharePolicy) pushes docs to a client unsolicited', async () => {
    const server = await makeServer({ floodAll: true })
    const a = server.repo.create({ n: 1 }); await a.whenReady()
    const b = server.repo.create({ n: 2 }); await b.whenReady()
    const client = makeClient(server.port)
    try {
      const got = await until(() => Object.keys(client.repo.handles).length, (n) => n >= 2)
      expect(got).toBeGreaterThanOrEqual(2) // received both without asking
    } finally {
      client.close()
      await server.close()
    }
  })

  it('SELECTIVE announces only core docs but still SERVES non-core on request', async () => {
    const holder: { current: DocHandle<unknown> | null } = { current: null }
    const sel = createSelectiveSync(() => holder.current)
    const server = await makeServer({ shareConfig: sel.shareConfig })
    const meta = server.repo.create({ groups: {} }); await meta.whenReady()
    const registry = server.repo.create({ diagrams: {} }); await registry.whenReady()
    const root = server.repo.create({ modelUrl: '', modelMetaUrl: meta.url, shardUrls: [registry.url] })
    await root.whenReady()
    holder.current = root
    sel.refresh()

    const diagram = server.repo.create({ which: 'diagram-doc' }); await diagram.whenReady() // NOT core
    // Mirrors the browser's active-document policy: no proactive cached-doc
    // announcement, but explicit requests remain authorized.
    const requested = new Set<DocumentId>()
    const client = makeClient(server.port, {
      announce: async (_peer, documentId) => documentId !== undefined && requested.has(documentId),
      access: async () => true,
    })
    try {
      // Give proactive sync a chance; the non-core diagram doc must NOT arrive.
      await sleep(700)
      expect(Object.keys(client.repo.handles)).not.toContain(String(diagram.documentId))

      // The browser allow-lists the explicit target immediately before find().
      requested.add(diagram.documentId)
      client.repo.shareConfigChanged()
      const handle = await client.repo.find(diagram.url as AutomergeUrl)
      await handle.whenReady()
      expect((handle.doc() as { which: string }).which).toBe('diagram-doc')
    } finally {
      client.close()
      await server.close()
    }
  })

  it('SELECTIVE proactively serves a pinned empty write-head but not its historical segment', async () => {
    const holder: { current: DocHandle<unknown> | null } = { current: null }
    const sel = createSelectiveSync(() => holder.current)
    const server = await makeServer({ shareConfig: sel.shareConfig })
    const root = server.repo.create({ modelUrl: '', shardUrls: [] }); await root.whenReady()
    holder.current = root
    sel.refresh()
    const historical = server.repo.create({ objects: { old: { id: 'old' } } }); await historical.whenReady()
    const current = server.repo.create({ objects: {}, writeBatchIds: [] as string[], writeHeadVersion: 1 }); await current.whenReady()
    sel.setPinnedCore('land/version:object', String(current.documentId))
    server.repo.shareConfigChanged()
    const client = makeClient(server.port)
    try {
      const handles = await until(
        () => Object.keys(client.repo.handles),
        (ids) => ids.includes(String(current.documentId)),
      )
      expect(handles).toContain(String(current.documentId))
      expect(handles).not.toContain(String(historical.documentId))
      const handle = await client.repo.find(current.url as AutomergeUrl)
      await handle.whenReady()
      expect(handle.doc()).toMatchObject({ objects: {}, writeBatchIds: [], writeHeadVersion: 1 })
    } finally {
      client.close()
      await server.close()
    }
  })

  it('SELECTIVE keeps live edits flowing once a doc is open on both peers', async () => {
    const holder: { current: DocHandle<unknown> | null } = { current: null }
    const sel = createSelectiveSync(() => holder.current)
    const server = await makeServer({ shareConfig: sel.shareConfig })
    const root = server.repo.create({ modelUrl: '', shardUrls: [] }); await root.whenReady()
    holder.current = root
    sel.refresh()

    const doc = server.repo.create({ count: 0 }); await doc.whenReady()
    const client = makeClient(server.port)
    try {
      const handle = await client.repo.find(doc.url as AutomergeUrl)
      await handle.whenReady()
      // A server-side edit must propagate to the client's open handle.
      doc.change((d: { count: number }) => { d.count = 42 })
      const v = await until(() => (handle.doc() as { count: number })?.count, (c) => c === 42)
      expect(v).toBe(42)
    } finally {
      client.close()
      await server.close()
    }
  })
})
