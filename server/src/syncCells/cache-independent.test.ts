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

// Independent QA controls adopted from the external T-12b mutation battery.
// Real loopback HTTP; synthetic ownership and SQL. No application/DB verdict.
import { createServer, get, type Server } from 'node:http'
import { EventEmitter, once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceHttpRouting } from './workspaceHttpRoute.js'
import { createSingleFlightWorkspaceRouteResolver, getSharedWorkspaceRouteResolver } from './workspaceRoute.js'
import { startWorkspaceCacheInvalidation, WORKSPACE_ROUTE_CHANGED_CHANNEL } from '../rbac/workspaceCacheInvalidation.js'
import type { SyncCellOwnership } from './ownership.js'

const workspace = { landscapeId: 'L-independent-cache', versionId: 'V-independent-cache' }
const rows = (value = workspace) => ({ rows: [{ landscape_id: value.landscapeId, version_id: value.versionId }] })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const servers: Server[] = []
async function listen(server: Server) {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No allocated ephemeral TCP port')
  return `http://127.0.0.1:${address.port}`
}
async function request(base: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = get(`${base}/api/automerge/root?landscapeId=${workspace.landscapeId}&versionId=${workspace.versionId}`,
      { headers, agent: false }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('HTTP response aborted')))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
    req.on('error', reject)
    req.setTimeout(2_000, () => req.destroy(new Error('QA HTTP request deadline')))
  })
}
function localOwnership(owns: boolean, advertiseUrl?: string): SyncCellOwnership {
  const readSnapshot = () => ({ cellId: 'qa-landing', partitionIndex: 0 })
  return { enabled: true, owns: () => owns, partitionFor: () => 1,
    readSnapshot, snapshot: readSnapshot,
    resolveOwner: async () => advertiseUrl ? { cellId: 'qa-live-upstream', partition: 1, advertiseUrl } : null,
  } as unknown as SyncCellOwnership
}
afterEach(async () => {
  const closing = servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  await Promise.all(closing)
  vi.restoreAllMocks()
})

describe('independent canonical cache and HTTP controls', () => {
  it('serves exactly 100 real hot HTTP requests after a native 650 ms gap, then a shared invalidation forces SQL', async () => {
    const db = { query: vi.fn(async () => rows()) }
    let arrivals = 0
    const app = express()
    app.use((_req, _res, next) => { arrivals += 1; next() })
    app.use(createWorkspaceHttpRouting({ db: db as never, ownership: () => localOwnership(true), authorize: async () => true }))
    app.use((_req, res) => res.json({ servedBy: 'qa-local-handler' }))
    const base = await listen(createServer(app))
    const coldAt = performance.now()
    expect((await request(base)).status).toBe(200)
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('FROM versions'), [workspace.landscapeId, workspace.versionId])
    await delay(650)
    expect(performance.now() - coldAt).toBeGreaterThanOrEqual(650)
    for (let index = 0; index < 100; index += 1) {
      const response = await request(base)
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ servedBy: 'qa-local-handler' })
    }
    expect(performance.now() - coldAt).toBeLessThan(30_000)
    expect(arrivals).toBe(101)
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(getSharedWorkspaceRouteResolver(db as never).invalidate(workspace.landscapeId)).toBe(1)
    expect((await request(base)).status).toBe(200)
    expect(arrivals).toBe(102)
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('refuses a routed request with route-loop while the counted upstream remains reachable and returns 200', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    let upstreamArrivals = 0
    const upstream = await listen(createServer((_req, res) => {
      upstreamArrivals += 1
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ servedBy: 'qa-live-upstream' }))
    }))
    const app = express()
    app.use(createWorkspaceHttpRouting({ db: { query: vi.fn(async () => rows()) } as never,
      ownership: () => localOwnership(false, upstream), ownershipRequired: () => true, authorize: async () => true }))
    app.use((_req, res) => res.status(599).end('unexpected local admission'))
    const landing = await listen(createServer(app))
    const first = await request(landing)
    expect(first.status).toBe(200)
    expect(JSON.parse(first.body)).toEqual({ servedBy: 'qa-live-upstream' })
    expect(upstreamArrivals).toBe(1)
    const loop = await request(landing, { 'x-maplespire-sync-http-routed': 'qa-old-owner-still-alive' })
    expect(loop.status).toBe(503)
    expect(JSON.parse(loop.body)).toMatchObject({ retryable: true })
    expect(upstreamArrivals).toBe(1)
    expect(warning.mock.calls.some(([line]) => {
      if (typeof line !== 'string' || !line.startsWith('{')) return false
      const event = JSON.parse(line)
      return event.event === 'sync.cell.http_route_rejected' && event.reason === 'route-loop'
    })).toBe(true)
    expect((await request(upstream)).status).toBe(200)
    expect(upstreamArrivals).toBe(2)
  })

  it('joining the final LISTEN invalidates both a warm route and an old SQL flight through the shared resolver', async () => {
    const listenGate = deferred<{ rows: never[] }>()
    const oldAnswer = deferred<ReturnType<typeof rows>>()
    const lateWorkspace = { landscapeId: 'L-gap', versionId: 'V-gap' }
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn((sql: string) => sql.startsWith('SELECT current_schema')
        ? Promise.resolve({ rows: [{ schema: 'qa_schema' }] })
        : sql === `LISTEN ${WORKSPACE_ROUTE_CHANGED_CHANNEL}` ? listenGate.promise : Promise.resolve({ rows: [] })),
      release: vi.fn(),
    })
    const db = { connect: vi.fn(async () => client), query: vi.fn()
      .mockResolvedValueOnce(rows()).mockReturnValueOnce(oldAnswer.promise).mockResolvedValue(rows(lateWorkspace)) }
    const resolver = getSharedWorkspaceRouteResolver(db as never)
    let resets = 0
    const handle = startWorkspaceCacheInvalidation(db as never, {
      onCoverageChanged: () => undefined, onVersionCreated: () => undefined,
      onRouteChanged: landscapeId => { resets += 1; if (landscapeId === null) resolver.invalidateAll(); else resolver.invalidate(landscapeId) },
    })
    let old: Promise<unknown> | undefined
    let fresh: Promise<unknown> | undefined
    try {
      await vi.waitFor(() => expect(client.query).toHaveBeenCalledWith(`LISTEN ${WORKSPACE_ROUTE_CHANGED_CHANNEL}`))
      expect(resets).toBe(0)
      await resolver(db as never, workspace)
      old = resolver(db as never, lateWorkspace)
      expect(db.query).toHaveBeenCalledTimes(2)
      listenGate.resolve({ rows: [] })
      await vi.waitFor(() => expect(resets).toBe(1))
      fresh = resolver(db as never, lateWorkspace)
      expect(db.query).toHaveBeenCalledTimes(3)
      await expect(fresh).resolves.toEqual(lateWorkspace)
      oldAnswer.resolve(rows({ ...lateWorkspace, versionId: 'V-stale' }))
      await old
      await expect(resolver(db as never, lateWorkspace)).resolves.toEqual(lateWorkspace)
      expect(db.query).toHaveBeenCalledTimes(3)
      await resolver(db as never, workspace)
      expect(db.query).toHaveBeenCalledTimes(4)
    } finally {
      listenGate.resolve({ rows: [] })
      oldAnswer.resolve(rows(lateWorkspace))
      await Promise.allSettled([old, fresh].filter((value): value is Promise<unknown> => Boolean(value)))
      await handle.stop()
    }
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('a settled obsolete flight cannot detach its still-pending replacement', async () => {
    const old = deferred<typeof workspace>()
    const replacement = deferred<typeof workspace>()
    const base = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise).mockResolvedValue(workspace)
    const resolver = createSingleFlightWorkspaceRouteResolver(base)
    const db = {} as never
    const first = resolver(db, workspace)
    resolver.invalidate(workspace.landscapeId)
    const second = resolver(db, workspace)
    try {
      expect(base).toHaveBeenCalledTimes(2)
      old.resolve({ ...workspace, versionId: 'V-obsolete' })
      await first
      expect(resolver(db, workspace)).toBe(second)
      expect(base).toHaveBeenCalledTimes(2)
    } finally {
      old.resolve(workspace)
      replacement.resolve(workspace)
      await Promise.allSettled([first, second])
    }
    await expect(resolver(db, workspace)).resolves.toEqual(workspace)
  })
})
