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
import { readFile } from 'node:fs/promises'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SyncCellOwnership } from './ownership.js'
import { createWorkspaceHttpRouting, parseWorkspaceHttpRoute } from './workspaceHttpRoute.js'

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port')
  return address.port
}

function ownership(overrides: Partial<SyncCellOwnership>): SyncCellOwnership {
  return {
    enabled: true,
    partitionFor: () => 1,
    ownsPartition: () => false,
    owns: () => false,
    fencingToken: () => null,
    resolveOwner: async () => null,
    onOwnershipLost: () => () => undefined,
    snapshot: () => ({ cellId: 'landing-cell', partitionIndex: 0 } as never),
    readSnapshot: () => ({ cellId: 'landing-cell', partitionIndex: 0 } as never),
    ...overrides,
  }
}

describe('parseWorkspaceHttpRoute', () => {
  it('routes only Repo/read-model paths and applies the legacy default workspace contract', () => {
    expect(parseWorkspaceHttpRoute('/api/model/diagram-render?id=d1', 'GET')).toEqual({
      kind: 'workspace',
      workspace: { landscapeId: 'default', versionId: 'current' },
    })
    expect(parseWorkspaceHttpRoute('/api/automerge/root?landscapeId=L1&versionId=V1', 'GET')).toEqual({
      kind: 'workspace',
      workspace: { landscapeId: 'L1', versionId: 'V1' },
    })
    expect(parseWorkspaceHttpRoute('/api/model/compact', 'POST').kind).toBe('workspace')
    expect(parseWorkspaceHttpRoute('/api/automerge/gc', 'POST').kind).toBe('workspace')
    expect(parseWorkspaceHttpRoute('/api/automerge/durable-heads?landscapeId=L1&versionId=V1', 'POST'))
      .toEqual({ kind: 'workspace', workspace: { landscapeId: 'L1', versionId: 'V1' } })
    expect(parseWorkspaceHttpRoute('/api/model/compact', 'PUT')).toEqual({ kind: 'not-workspace' })
    expect(parseWorkspaceHttpRoute('/api/me/workspace-access?landscapeId=L1&versionId=V1', 'GET'))
      .toEqual({ kind: 'not-workspace' })
    expect(parseWorkspaceHttpRoute('/api/auth/me', 'GET')).toEqual({ kind: 'not-workspace' })
  })

  it('routes the current handlers that check workspace ownership', async () => {
    // The projector-fleet endpoint is deliberately absent: its handler reads
    // local counters and does not call ensureWorkspace. Its local diagnostic
    // contract is tested separately below.
    for (const [path, method] of [
      ['/api/model/durability-witness?landscapeId=L1&versionId=V1', 'POST'],
      ['/api/model/related-diagram-object-ids?landscapeId=L1&versionId=V1', 'POST'],
    ] as const) {
      expect(
        parseWorkspaceHttpRoute(path, method),
        `${method} ${path} checks ownership but is not routed — it 503s on a non-owner`,
      ).toEqual({ kind: 'workspace', workspace: { landscapeId: 'L1', versionId: 'V1' } })
    }

    // AND THE SET IS DERIVED FROM THE TREE, not from memory: every
    // `ensureWorkspace` route in `index.ts` must be routable. This is what makes
    // the assertion above stay true when a new route is added.
    const source = await readFile(new URL('../index.ts', import.meta.url), 'utf8')
    const routes = [...source.matchAll(/app\.(get|post)\('(\/api\/[^']+)'[\s\S]{0,400}?await ensureWorkspace\(req, res\)/g)]
      .map((match) => [match[2]!, match[1]!.toUpperCase()] as const)
    // The control: a scan that found nothing would make the loop below vacuous.
    expect(routes.length, 'the ensureWorkspace scan found nothing — it is broken, not the tree')
      .toBeGreaterThan(20)

    const unrouted = routes.filter(([path, method]) => {
      // `:id` params never appear literally in a request; probe a concrete value.
      const concrete = path.replace(/:[A-Za-z]+/g, 'x')
      return parseWorkspaceHttpRoute(`${concrete}?landscapeId=L1&versionId=V1`, method).kind !== 'workspace'
    })
    expect(unrouted, 'these routes check ownership but are not owner-routed').toEqual([])
  })

  it('keeps projector fleet diagnostics local regardless of workspace query or GET/HEAD', () => {
    for (const method of ['GET', 'HEAD']) for (const query of ['', '?landscapeId=L1&versionId=V1', '?landscapeId=../invalid']) {
      expect(parseWorkspaceHttpRoute(`/api/platform/read-model/projector-fleet${query}`, method)).toEqual({ kind: 'not-workspace' })
    }
  })

  it('rejects ambiguous and malformed workspace hints before any owner lookup', () => {
    expect(parseWorkspaceHttpRoute('/api/model/search?landscapeId=L1&landscapeId=L2', 'GET'))
      .toEqual({ kind: 'invalid' })
    expect(parseWorkspaceHttpRoute('/api/automerge/root?landscapeId=../L1', 'GET'))
      .toEqual({ kind: 'invalid' })
  })
})

describe('createWorkspaceHttpRouting', () => {
  const servers: Server[] = []

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  it('returns the reserve own fleet over HTTP while workspace reads still reach the owner', async () => {
    let ownerCalls = 0
    const ownerServer = createServer((_request, response) => {
      ownerCalls++
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ servedBy: 'owner-b', residentProjectors: 7 }))
    })
    servers.push(ownerServer)
    const ownerPort = await listen(ownerServer)
    const resolveWorkspace = vi.fn().mockResolvedValue({ landscapeId: 'L1', versionId: 'V1' })
    const authorize = vi.fn().mockResolvedValue(true)
    const app = express()
    app.use(createWorkspaceHttpRouting({
      db: {} as never, resolveWorkspace, authorize,
      ownership: () => ownership({
        readSnapshot: () => ({ cellId: 'reserve-c', partitionIndex: null } as never),
        resolveOwner: async () => ({ cellId: 'owner-b', token: '7', partition: 1, advertiseUrl: `http://127.0.0.1:${ownerPort}` }),
      }),
    }))
    let localCount = 0
    app.get('/api/platform/read-model/projector-fleet', (_request, response) => response.json({ servedBy: 'reserve-c', residentProjectors: localCount }))
    app.get('/api/model/search', (_request, response) => response.status(500).json({ error: 'workspace read ran locally' }))
    const reserve = createServer(app)
    servers.push(reserve)
    const reservePort = await listen(reserve)
    for (localCount = 0; localCount < 2; localCount++) {
      const response = await fetch(`http://127.0.0.1:${reservePort}/api/platform/read-model/projector-fleet?landscapeId=L1&versionId=V1`)
      expect(response.status).toBe(200)
      expect(response.headers.get('x-maplespire-sync-route')).toBeNull()
      await expect(response.json()).resolves.toEqual({ servedBy: 'reserve-c', residentProjectors: localCount })
    }
    expect(ownerCalls).toBe(0)
    expect(resolveWorkspace).not.toHaveBeenCalled()
    expect(authorize).not.toHaveBeenCalled()
    const routed = await fetch(`http://127.0.0.1:${reservePort}/api/model/search?landscapeId=L1&versionId=V1`)
    expect(routed.status).toBe(200)
    expect(routed.headers.get('x-maplespire-sync-route')).toBe('proxied')
    await expect(routed.json()).resolves.toEqual({ servedBy: 'owner-b', residentProjectors: 7 })
    expect(ownerCalls).toBe(1)
  })

  it('canonicalizes and authorizes before proxying cookie-bearing traffic exactly once', async () => {
    let observedUrl = ''
    let observedCookie = ''
    let observedRoutedBy = ''
    const ownerServer = createServer((request, response) => {
      observedUrl = request.url ?? ''
      observedCookie = request.headers.cookie ?? ''
      observedRoutedBy = String(request.headers['x-maplespire-sync-http-routed'] ?? '')
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ servedBy: 'owner' }))
    })
    servers.push(ownerServer)
    const ownerPort = await listen(ownerServer)

    const resolveWorkspace = vi.fn().mockResolvedValue({ landscapeId: 'L1', versionId: 'V9' })
    const authorize = vi.fn().mockResolvedValue(true)
    // The OWNERSHIP questions read their argument, because the real
    // coordinator's lease map is keyed on the canonical version id: asked
    // about the `current` alias, `owns` misses on the true owner and the cell
    // answers 503 for a workspace it holds. Fixtures that ignore the argument
    // cannot catch that, so it is pinned here, in the fast loop, for `owns`,
    // `partitionFor` and `resolveOwner` alike.
    const canonical = { landscapeId: 'L1', versionId: 'V9' }
    const owns = vi.fn((workspace: { versionId: string }) => workspace.versionId === 'V9' && false)
    const partitionFor = vi.fn((workspace: { versionId: string }) => (workspace.versionId === 'V9' ? 1 : 99))
    const resolveOwner = vi.fn(async (workspace: { versionId: string }) => (workspace.versionId === 'V9'
      ? { cellId: 'owner-cell', token: '7', partition: 1, advertiseUrl: `http://127.0.0.1:${ownerPort}` }
      : null))
    const app = express()
    app.use(createWorkspaceHttpRouting({
      db: {} as never,
      ownership: () => ownership({ owns, partitionFor, resolveOwner }),
      resolveWorkspace,
      authorize,
    }))
    app.get('/api/automerge/root', (_request, response) => response.status(500).json({ error: 'local handler ran' }))
    const landing = createServer(app)
    servers.push(landing)
    const landingPort = await listen(landing)

    const response = await fetch(
      `http://127.0.0.1:${landingPort}/api/automerge/root?landscapeId=L1&versionId=current`,
      { headers: { Cookie: 'maplespire_session=opaque' } },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('x-maplespire-sync-route')).toBe('proxied')
    await expect(response.json()).resolves.toEqual({ servedBy: 'owner' })
    expect(resolveWorkspace).toHaveBeenCalledWith(expect.anything(), { landscapeId: 'L1', versionId: 'current' })
    expect(authorize).toHaveBeenCalledWith(expect.anything(), expect.anything(), canonical)
    expect(owns).toHaveBeenCalledWith(canonical)
    expect(partitionFor).toHaveBeenCalledWith(canonical)
    expect(resolveOwner).toHaveBeenCalledWith(canonical)
    for (const spy of [owns, partitionFor, resolveOwner]) {
      expect(spy.mock.calls.some(([workspace]) => (workspace as { versionId: string }).versionId === 'current'), 'asked about the alias').toBe(false)
    }
    expect(observedUrl).toBe('/api/automerge/root?landscapeId=L1&versionId=current')
    expect(observedCookie).toBe('maplespire_session=opaque')
    expect(observedRoutedBy).toBe('landing-cell')
  })

  it('a decision that THROWS — a lookup, the canonicaliser, the owner resolution — answers 503 `workspace routing unavailable`, retryable, and never runs the handler', async () => {
    // A database or Redis failure while DECIDING. The contract is the atomic,
    // retryable 503 before anything is written — never `next()`, the unrouted
    // local execution the middleware exists to prevent. Three throw sites, one
    // arm.
    const cases: Array<[string, Parameters<typeof createWorkspaceHttpRouting>[0], string]> = [
      ['the canonicaliser', {
        db: {} as never,
        ownership: () => ownership({}),
        resolveWorkspace: vi.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect')),
        authorize: vi.fn().mockResolvedValue(true),
      }, '/api/automerge/root?landscapeId=L1&versionId=V1'],
      ['the merge parent lookup', {
        db: {} as never,
        ownership: () => ownership({}),
        resolveWorkspace: vi.fn().mockResolvedValue({ landscapeId: 'L1', versionId: 'V1' }),
        authorize: vi.fn().mockResolvedValue(true),
        resolveMergeParent: vi.fn().mockRejectedValue(new Error('connection terminated')),
      }, '/api/landscapes/L1/drafts/D9/merge'],
      ['the owner resolution', {
        db: {} as never,
        ownership: () => ownership({ resolveOwner: async () => { throw new Error('redis command timed out') } }),
        resolveWorkspace: vi.fn().mockResolvedValue({ landscapeId: 'L1', versionId: 'V1' }),
        authorize: vi.fn().mockResolvedValue(true),
      }, '/api/automerge/root?landscapeId=L1&versionId=V1'],
    ]
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const [label, options, path] of cases) {
        let handlerRan = 0
        const app = express()
        app.use(express.json())
        app.use(createWorkspaceHttpRouting(options))
        app.all(/.*/, (_request, response) => { handlerRan += 1; response.status(200).json({ ran: 'locally' }) })
        const landing = createServer(app)
        servers.push(landing)
        const port = await listen(landing)
        const response = await fetch(`http://127.0.0.1:${port}${path}`, path.endsWith('/merge')
          ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }
          : {})
        expect(response.status, label).toBe(503)
        await expect(response.json()).resolves.toEqual({ error: 'workspace routing unavailable', retryable: true })
        expect(handlerRan, `${label}: the handler ran on a cell that could not decide`).toBe(0)
      }
      expect(error).toHaveBeenCalledTimes(cases.length)
    } finally {
      error.mockRestore()
    }
  })

  it('serves locally on the owner, leaves stateless APIs alone, and fails closed on a route loop', async () => {
    const resolveWorkspace = vi.fn().mockResolvedValue({ landscapeId: 'L1', versionId: 'V1' })
    const app = express()
    let owns = true
    app.use(createWorkspaceHttpRouting({
      db: {} as never,
      ownership: () => ownership({
        owns: () => owns,
        resolveOwner: async () => ({
          cellId: 'other-cell', token: '8', partition: 1, advertiseUrl: 'http://127.0.0.1:1',
        }),
      }),
      resolveWorkspace,
      authorize: async () => true,
    }))
    app.get('/api/model/search', (_request, response) => response.json({ local: true }))
    app.get('/api/auth/me', (_request, response) => response.json({ stateless: true }))
    const server = createServer(app)
    servers.push(server)
    const port = await listen(server)

    const local = await fetch(`http://127.0.0.1:${port}/api/model/search?landscapeId=L1&versionId=V1`)
    expect(local.status).toBe(200)
    expect(local.headers.get('x-maplespire-sync-route')).toBe('owner')
    await expect(local.json()).resolves.toEqual({ local: true })

    const stateless = await fetch(`http://127.0.0.1:${port}/api/auth/me`)
    expect(stateless.headers.get('x-maplespire-sync-route')).toBeNull()
    await expect(stateless.json()).resolves.toEqual({ stateless: true })
    expect(resolveWorkspace).toHaveBeenCalledTimes(1)

    owns = false
    const loop = await fetch(`http://127.0.0.1:${port}/api/model/search?landscapeId=L1&versionId=V1`, {
      headers: { 'x-maplespire-sync-http-routed': 'previous-cell' },
    })
    expect(loop.status).toBe(503)
    await expect(loop.json()).resolves.toMatchObject({ retryable: true })
  })
})

/**
 * THE ADMISSION GATE MUST CLAIM EVERY SPELLING EXPRESS WILL SERVE.
 *
 * `isWorkspaceHttpPath` matches with `===` and `startsWith`, both case- and
 * slash-sensitive. Express does neither: `case sensitive routing` and
 * `strict routing` default to false and `server/src/index.ts` sets NEITHER.
 *
 * So without normalisation, `POST /API/model/compact` and
 * `POST /api/automerge/durable-heads/` would reach their handlers while the
 * gate answered `not-workspace`, and the write would run on whichever cell the
 * load balancer picked — the unrouted write the whole routing layer exists to
 * remove. The first arm below shows, against a real Express app mounted in
 * this process, that every such spelling reaches the handler.
 *
 * Two arms, and the first is what makes the second more than a preference: a
 * normalisation nobody needs is a normalisation nobody should write.
 */
describe('the admission gate is a SUPERSET of what Express routes', () => {
  const servers: Server[] = []
  afterEach(async () => {
    while (servers.length) {
      const server = servers.pop()!
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  /** Every admitted POST path is a fixed literal — the workspace comes from the
   *  QUERY STRING, never the path — so normalising the pathname cannot damage a
   *  captured id. That is what makes this fix safe HERE and not safe for the
   *  merge path, whose ids are IN the path and are case-sensitive in Postgres. */
  const ADMITTED_POST_PATHS = [
    '/api/model/compact',
    '/api/automerge/gc',
    '/api/automerge/durable-heads',
    '/api/model/durability-witness',
    '/api/model/related-diagram-object-ids',
  ]

  const spellings = (pathname: string): string[] => [
    pathname.toUpperCase(),
    `${pathname}/`,
    pathname.replace('/api/', '/API/'),
  ]

  it('Express really does serve those spellings — the premise, not an assumption', async () => {
    const app = express()
    const reached: string[] = []
    for (const pathname of ADMITTED_POST_PATHS) {
      app.post(pathname, (request, response) => {
        reached.push(request.originalUrl)
        response.json({ ok: true })
      })
    }
    const server = createServer(app)
    servers.push(server)
    const port = await listen(server)

    for (const pathname of ADMITTED_POST_PATHS) {
      for (const spelling of spellings(pathname)) {
        const answer = await fetch(`http://127.0.0.1:${port}${spelling}`, { method: 'POST' })
        expect(answer.status, `${spelling} did not reach a handler`).toBe(200)
      }
    }
    // The vacuity control: without it every assertion above would also pass
    // against an app that answered 200 from a catch-all and routed nothing.
    expect(reached.length).toBe(ADMITTED_POST_PATHS.length * 3)
  })

  it('and the gate claims every one of them', () => {
    const escaped: string[] = []
    for (const pathname of ADMITTED_POST_PATHS) {
      for (const spelling of spellings(pathname)) {
        const parsed = parseWorkspaceHttpRoute(`${spelling}?landscapeId=L1&versionId=V1`, 'POST')
        if (parsed.kind !== 'workspace') escaped.push(`${spelling} -> ${parsed.kind}`)
      }
    }
    expect(
      escaped,
      'these spellings reach a handler but are not claimed by the routing gate, so the write '
      + 'executes on the landing cell unrouted — change one letter of the URL and the routing '
      + 'layer is gone',
    ).toEqual([])
  })

  it('but it still refuses paths that are not admitted at all', () => {
    // The control that keeps the fix honest. Normalising too eagerly — matching
    // on a prefix, say — would claim the whole API and make the arm above pass
    // for the wrong reason.
    for (const pathname of ['/api/auth/me', '/api/model/compactify', '/api/automerge/gcc', '/healthz']) {
      expect(
        parseWorkspaceHttpRoute(`${pathname}?landscapeId=L1&versionId=V1`, 'POST').kind,
        `${pathname} was claimed and should not be`,
      ).toBe('not-workspace')
    }
  })

  it('Express serves the AI tool door with the NAME decoded and case-PRESERVED — the premise of its predicate (B2-10a)', async () => {
    // The door's parameter is the tool name, and the registry looks it up in a
    // `Map`. So the gate has to claim every spelling that reaches the handler
    // AS `create_draft` and none that reaches it as something else. What
    // Express does with case and percent-encoding in a PARAM is measured here
    // rather than remembered.
    const app = express()
    const seen: string[] = []
    app.post('/api/ai/tools/:name', (request, response) => {
      seen.push(String(request.params.name))
      response.json({ ok: true })
    })
    const server = createServer(app)
    servers.push(server)
    const port = await listen(server)

    const served: ReadonlyArray<readonly [string, string]> = [
      ['/api/ai/tools/create_draft', 'create_draft'],
      ['/API/AI/TOOLS/create_draft', 'create_draft'],
      ['/api/ai/tools/create%5Fdraft', 'create_draft'],
      ['/api/ai/tools/create_draft/', 'create_draft'],
      // Served, with the case Express was given: the registry misses it.
      ['/api/ai/tools/CREATE_DRAFT', 'CREATE_DRAFT'],
    ]
    for (const [spelling] of served) {
      const answer = await fetch(`http://127.0.0.1:${port}${spelling}`, { method: 'POST' })
      expect(answer.status, `${spelling} did not reach the handler`).toBe(200)
    }
    expect(seen).toEqual(served.map(([, name]) => name))
    // The near-misses Express itself refuses, so the gate must not claim them.
    for (const miss of ['/api/ai/tools/create_draft/extra', '/api/ai/tools//create_draft', '/api/ai/tools/%ZZ']) {
      const answer = await fetch(`http://127.0.0.1:${port}${miss}`, { method: 'POST' })
      expect(answer.status, `${miss} reached a handler`).not.toBe(200)
    }

    // And the gate agrees with every one of those measurements.
    const body = { landscapeId: 'L-1', input: { label: 'x' } }
    for (const [spelling, name] of served) {
      const parsed = parseWorkspaceHttpRoute(spelling, 'POST', body)
      if (name === 'create_draft') {
        expect(parsed, `${spelling} reaches create_draft and is not placed`).toEqual({ kind: 'needs-landscape-default', landscapeId: 'L-1' })
      } else {
        // A registry MISS is still a tool door, and the generic entry places it
        // on its body's key: the owner answers the 404, with the body the
        // landing cell would have answered. What must NOT happen is the FORK
        // key — a case-insensitive compare would produce it, and this pair of
        // branches exists to catch that.
        expect(parsed, `${spelling} is a registry miss and must be placed on its BODY's key, never the fork key`)
          .toEqual({ kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'current' } })
      }
    }
    for (const miss of ['/api/ai/tools/create_draft/extra', '/api/ai/tools//create_draft', '/api/ai/tools/%ZZ']) {
      expect(parseWorkspaceHttpRoute(miss, 'POST', body).kind, miss).toBe('not-workspace')
    }
  })
})

/**
 * THE FIVE WRITE FAMILIES, END TO END THROUGH A REAL PROXY.
 *
 * The arms above measure ADMISSION. These measure what admission is for: if
 * the gate normalises the pathname and `rebuildsJsonBody` does not, admitted
 * body-bearing POSTs are proxied with their `content-type` and
 * `content-length` DELETED, and the owner's `express.json` sees `{}` and
 * answers 400 for a body the client sent.
 *
 * A STATUS ASSERTION WOULD STAY GREEN THROUGH THAT. So the assertion
 * here is that the OWNER RECEIVED THE BODY — both ids, parsed — and it is made
 * on a NON-CANONICAL spelling, which is the only kind that exercises the
 * disagreement.
 */
describe('the write families reach the owner WITH their body (B2-5)', () => {
  const servers: Server[] = []
  afterEach(async () => {
    while (servers.length) {
      const server = servers.pop()!
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  async function landingCellFor(overrides: Partial<Parameters<typeof createWorkspaceHttpRouting>[0]> = {}): Promise<{
    port: number
    received: Array<{ url: string; body: unknown }>
    local: string[]
  }> {
    const received: Array<{ url: string; body: unknown }> = []
    const ownerApp = express()
    ownerApp.use(express.json())
    ownerApp.post('*splat', (request, response) => {
      received.push({ url: request.originalUrl, body: request.body })
      response.json({ servedBy: 'owner', echo: request.body })
    })
    const ownerServer = createServer(ownerApp)
    servers.push(ownerServer)
    const ownerPort = await listen(ownerServer)

    const local: string[] = []
    const app = express()
    // The same order as `index.ts`: `express.json` consumes the stream BEFORE
    // the routing middleware runs, which is precisely why the proxy has to
    // rebuild the body rather than pipe it.
    app.use(express.json())
    app.use(createWorkspaceHttpRouting({
      db: {} as never,
      ownership: () => ownership({
        owns: () => false,
        resolveOwner: async () => ({
          cellId: 'owner-cell', token: '9', partition: 1,
          advertiseUrl: `http://127.0.0.1:${ownerPort}`,
        }),
      }),
      resolveWorkspace: async (_db, requested) => requested,
      authorize: async () => true,
      ...overrides,
    }))
    app.post('*splat', (request, response) => {
      local.push(request.originalUrl)
      response.json({ servedBy: 'landing' })
    })
    const landing = createServer(app)
    servers.push(landing)
    return { port: await listen(landing), received, local }
  }

  const post = (port: number, pathname: string, body: unknown): Promise<Response> => fetch(
    `http://127.0.0.1:${port}${pathname}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  )

  it('a body family reaches the owner with BOTH ids — on a spelling only the normaliser accepts', async () => {
    const cell = await landingCellFor()
    // `/API/…/repair/` — upper case AND a trailing slash. Express serves it,
    // the gate claims it, and the proxy must forward its body.
    const answer = await post(cell.port, '/API/platform/reference-integrity/repair/', {
      landscapeId: 'L-7', versionId: 'V-7', apply: true,
    })

    expect(answer.status).toBe(200)
    expect(answer.headers.get('x-maplespire-sync-route')).toBe('proxied')
    expect(cell.local, 'the landing cell served it instead of routing it').toEqual([])
    expect(cell.received).toHaveLength(1)
    expect(
      cell.received[0]!.body,
      'the owner did not receive the body — this is the defect a status assertion cannot see',
    ).toEqual({ landscapeId: 'L-7', versionId: 'V-7', apply: true })
  })

  it('…and on the canonical spelling too, which is the control that keeps the arm honest', async () => {
    const cell = await landingCellFor()
    const answer = await post(cell.port, '/api/platform/workspace/promote-summary', {
      landscapeId: 'L-7', versionId: 'V-7', apply: true,
    })
    expect(answer.status).toBe(200)
    expect(cell.received[0]!.body).toEqual({ landscapeId: 'L-7', versionId: 'V-7', apply: true })
  })

  it('a REPORT is served where it landed — it needs no owner and must survive an outage', async () => {
    const cell = await landingCellFor()
    const answer = await post(cell.port, '/api/platform/reference-integrity/repair', {
      landscapeId: 'L-7', versionId: 'V-7',
    })
    expect(answer.status).toBe(200)
    await expect(answer.json()).resolves.toEqual({ servedBy: 'landing' })
    expect(cell.received, 'the dry run was routed; it is deliberately not gated').toEqual([])
  })

  it('the MERGE is placed on the parent the lookup returns, not on the draft', async () => {
    const cell = await landingCellFor({
      resolveMergeParent: async (_db, landscapeId, draftId) => {
        expect([landscapeId, draftId]).toEqual(['L-1', 'D-9'])
        return { kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'V-parent' } }
      },
      resolveWorkspace: async (_db, requested) => {
        // The proof that the PARENT was placed: the canonicaliser is asked
        // about `V-parent`, never about the draft.
        expect(requested).toEqual({ landscapeId: 'L-1', versionId: 'V-parent' })
        return requested
      },
    })
    const answer = await post(cell.port, '/api/landscapes/L-1/drafts/D-9/merge', { resolutions: { 'a:b:c': 'draft' } })
    expect(answer.status).toBe(200)
    expect(answer.headers.get('x-maplespire-sync-route')).toBe('proxied')
    expect(cell.received[0]!.body).toEqual({ resolutions: { 'a:b:c': 'draft' } })
    // The URL is forwarded verbatim, so the owner re-matches it with its own
    // Express — the ids keep their case across the hop.
    expect(cell.received[0]!.url).toBe('/api/landscapes/L-1/drafts/D-9/merge')
  })

  it('an unknown draft falls through to Express, which answers its own 404', async () => {
    const cell = await landingCellFor({
      resolveMergeParent: async () => ({ kind: 'no-such-draft' }),
    })
    const answer = await post(cell.port, '/api/landscapes/L-1/drafts/nope/merge', {})
    expect(answer.status).toBe(200)
    await expect(answer.json()).resolves.toEqual({ servedBy: 'landing' })
    expect(cell.received).toEqual([])
  })

  it('a draft that EXISTS and cannot be merged is refused HERE, before any root can rotate', async () => {
    // The distinction that needs three answers instead of two. `resolveRootUrl`
    // has no `kind` filter, so a pass-through for a row that exists reaches
    // `ensureCanonicalWorkspaceRoot`, which can publish a fresh root and CAS
    // `versions.root_url` on a cell whose ownership nobody checked.
    for (const reason of ['not-a-draft', 'no-parent'] as const) {
      const cell = await landingCellFor({ resolveMergeParent: async () => ({ kind: 'unplaceable', reason }) })
      const answer = await post(cell.port, '/api/landscapes/L-1/drafts/V-live/merge', {})
      expect(answer.status, reason).toBe(404)
      await expect(answer.json()).resolves.toMatchObject({ reason })
      expect(cell.local, `${reason} reached the local handler`).toEqual([])
      expect(cell.received, `${reason} was proxied`).toEqual([])
    }
  })

  it('a WRITE family outlives the five seconds a READ family does not — deferral reason 2, measured', async () => {
    // THE ARM THAT COSTS FIVE SECONDS, and it is the only shape that proves the
    // thing. A 5 s header deadline bounds the whole OPERATION for these routes,
    // because each computes its result before writing a header — so a merge or
    // a promotion slower than that would get a 503 on the landing cell while
    // the owner kept executing it (`draft-merge` and `promote-summary` can take
    // over 10 s).
    //
    // Both requests are issued AGAINST THE SAME DELAYED OWNER, concurrently, so
    // the arm costs one delay rather than two — and the pair is what makes it
    // discriminating. Giving everything the long deadline passes the write half
    // and fails the read half; giving nothing the long deadline fails the write
    // half. Asserting only the write would be green
    // under "raise the default to 45 s", which is a different, worse change.
    const owner = createServer((_request, response) => {
      setTimeout(() => {
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ servedBy: 'owner' }))
      }, 5_400)
    })
    servers.push(owner)
    const ownerPort = await listen(owner)

    const app = express()
    app.use(express.json())
    app.use(createWorkspaceHttpRouting({
      db: {} as never,
      ownership: () => ownership({
        owns: () => false,
        resolveOwner: async () => ({
          cellId: 'owner-cell', token: '9', partition: 1,
          advertiseUrl: `http://127.0.0.1:${ownerPort}`,
        }),
      }),
      resolveWorkspace: async (_db, requested) => requested,
      authorize: async () => true,
      resolveLandscapeDefault: async () => ({ kind: 'workspace', workspace: { landscapeId: 'L-7', versionId: 'V-7' } }),
    }))
    const landing = createServer(app)
    servers.push(landing)
    const landingPort = await listen(landing)

    const [write, read, aiDoor] = await Promise.all([
      // THE QUERY STRING IS DELIBERATE. The router asks `isRoutedWritePath` for
      // the PARSED pathname; if it used the raw URL, this request would fall
      // back to the read family's five seconds and the arm would go red.
      post(landingPort, '/api/platform/workspace/repair-summary-flag?trace=b2-5', {
        landscapeId: 'L-7', versionId: 'V-7', apply: true,
      }),
      post(landingPort, '/api/model/durability-witness?landscapeId=L-7&versionId=V-7', { documents: [] }),
      // AND AN AI TOOL DOOR, against the same delayed owner. The door is a
      // routed write through a PREDICATE, not a pattern, so the router's use of
      // `isRoutedWritePath` for this door needs its own witness.
      post(landingPort, '/api/ai/tools/create_draft?trace=b2-10a', { landscapeId: 'L-7', input: { label: 'slow owner' } }),
    ])

    expect(write.status, 'the write family was cut off by the read family’s deadline').toBe(200)
    await expect(write.json()).resolves.toEqual({ servedBy: 'owner' })
    expect(read.status, 'the read family kept the historical five seconds').toBe(503)
    expect(aiDoor.status, 'the AI tool door was cut off by the read family’s deadline').toBe(200)
    await expect(aiDoor.json()).resolves.toEqual({ servedBy: 'owner' })
  }, 30_000)

  it('the two CREATION doors are placed on the landscape DEFAULT the lookup returns (B2-5d)', async () => {
    for (const pathname of ['/api/landscapes/L-1/drafts', '/API/landscapes/L-1/versions/']) {
      const cell = await landingCellFor({
        resolveLandscapeDefault: async (_db, landscapeId) => {
          expect(landscapeId).toBe('L-1')
          return { kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'V-default' } }
        },
        resolveWorkspace: async (_db, requested) => {
          // The proof that the DEFAULT was placed — never the body's source.
          expect(requested).toEqual({ landscapeId: 'L-1', versionId: 'V-default' })
          return requested
        },
      })
      const answer = await post(cell.port, pathname, { label: 'twin', forkFromVersionId: 'D-merged' })
      expect(answer.status, pathname).toBe(200)
      expect(answer.headers.get('x-maplespire-sync-route'), pathname).toBe('proxied')
      expect(cell.received[0]!.body, 'the owner must receive the body').toEqual({ label: 'twin', forkFromVersionId: 'D-merged' })
      expect(cell.received[0]!.url, 'forwarded verbatim, case intact').toBe(pathname)
    }
  })

  it('an unresolved landscape default falls through to Express, which answers its own 404', async () => {
    const cell = await landingCellFor({ resolveLandscapeDefault: async () => ({ kind: 'unresolved' }) })
    const answer = await post(cell.port, '/api/landscapes/nope/drafts', { label: 'x' })
    expect(answer.status).toBe(200)
    await expect(answer.json()).resolves.toEqual({ servedBy: 'landing' })
    expect(cell.received).toEqual([])
  })

  it('the three AI tool doors are placed on the key their BODY names and reach the owner WITH that body (B2-10a)', async () => {
    // create_draft, on the encoded spelling only the predicate accepts, keyed
    // on the landscape DEFAULT — never on the merged draft the body names as
    // its workspace or its source.
    const creation = { landscapeId: 'L-1', versionId: 'D-merged', input: { label: 'twin', forkFromVersionId: 'D-merged' } }
    const created = await landingCellFor({
      resolveLandscapeDefault: async (_db, landscapeId) => {
        expect(landscapeId).toBe('L-1')
        return { kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'V-default' } }
      },
      resolveWorkspace: async (_db, requested) => {
        expect(requested).toEqual({ landscapeId: 'L-1', versionId: 'V-default' })
        return requested
      },
    })
    const draft = await post(created.port, '/API/ai/tools/create%5Fdraft', creation)
    expect(draft.status).toBe(200)
    expect(draft.headers.get('x-maplespire-sync-route')).toBe('proxied')
    expect(created.local, 'the landing cell served the creation instead of routing it').toEqual([])
    expect(created.received[0]!.body, 'the owner must receive the body — input included').toEqual(creation)
    expect(created.received[0]!.url, 'forwarded verbatim, so the owner decodes the name itself').toBe('/API/ai/tools/create%5Fdraft')

    // merge_draft, keyed on the PARENT the lookup returns for
    // (body.landscapeId, input.draftId) — the draft is what the body names,
    // the parent is what the merge writes.
    const merge = { landscapeId: 'L-1', input: { draftId: 'D-9', resolutions: { 'a:b:c': 'draft' } } }
    const merged = await landingCellFor({
      resolveMergeParent: async (_db, landscapeId, draftId) => {
        expect([landscapeId, draftId]).toEqual(['L-1', 'D-9'])
        return { kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'V-parent' } }
      },
      resolveWorkspace: async (_db, requested) => {
        expect(requested).toEqual({ landscapeId: 'L-1', versionId: 'V-parent' })
        return requested
      },
    })
    const answer = await post(merged.port, '/api/ai/tools/merge_draft?trace=b2-10a', merge)
    expect(answer.status).toBe(200)
    expect(answer.headers.get('x-maplespire-sync-route')).toBe('proxied')
    expect(merged.received[0]!.body).toEqual(merge)
    expect(merged.received[0]!.url).toBe('/api/ai/tools/merge_draft?trace=b2-10a')

    // create_version with NO landscape in the body: the DEFAULT landscape,
    // as `resolveAiToolCtx` would derive it — not a pass-through.
    const defaulted = await landingCellFor({
      resolveLandscapeDefault: async (_db, landscapeId) => {
        expect(landscapeId).toBe('default')
        return { kind: 'workspace', workspace: { landscapeId: 'default', versionId: 'V-d' } }
      },
      resolveWorkspace: async (_db, requested) => requested,
    })
    const version = await post(defaulted.port, '/api/ai/tools/create_version', { input: { label: 'x' } })
    expect(version.status).toBe(200)
    expect(version.headers.get('x-maplespire-sync-route')).toBe('proxied')
    expect(defaulted.local).toEqual([])
    expect(defaulted.received[0]!.body).toEqual({ input: { label: 'x' } })
  })

  it('an ORDINARY tool reaches the owner on its BODY\'s key, with its body, and no fork lookup runs (B2-10d1)', async () => {
    // These four are placed on the owner; run on the landing cell,
    // `create_model_object` would answer 200 over a write the storage fence
    // then refused. The two lookups still throw if touched: the generic key is read from the
    // body, never from a database, so a fork lookup here would be the fork key
    // leaking onto tools that must not have it.
    const cell = await landingCellFor({
      resolveLandscapeDefault: async () => { throw new Error('the default lookup ran for a body-keyed tool') },
      resolveMergeParent: async () => { throw new Error('the parent lookup ran for a body-keyed tool') },
    })
    const sent = { landscapeId: 'L-1', input: { draftId: 'D-9' } }
    for (const pathname of ['/api/ai/tools/list_drafts', '/api/ai/tools/create_model_object', '/api/ai/tools/set_default_version', '/api/ai/tools/CREATE_DRAFT']) {
      const answer = await post(cell.port, pathname, sent)
      expect(answer.status, pathname).toBe(200)
      expect(answer.headers.get('x-maplespire-sync-route'), pathname).toBe('proxied')
      await expect(answer.json()).resolves.toMatchObject({ servedBy: 'owner' })
    }
    expect(cell.local, 'a placed tool was served on the landing cell').toEqual([])
    expect(cell.received).toHaveLength(4)
    // WITH THE BODY. `rebuildsJsonBody` covers every tool door, not only the
    // bootstrap doors; otherwise each of these four would be proxied,
    // answered, and applied to nothing.
    for (const received of cell.received) {
      expect(received.body, `${received.url} reached the owner bodyless`).toEqual(sent)
    }
  })

  it('THE BENCH BYPASS (B2-10c): armed, the header serves the tool door locally; unarmed, it is REFUSED 400', async () => {
    // A BUTTON THAT GOVERNS NOTHING IN PRODUCTION, and the three arms here are
    // the three constraints that make that true: the env var, the surface, and
    // — the one that matters most — that an unarmed cell REFUSES rather than
    // ignores. A cell that ignored the header would answer the bench a routed
    // result, and the bench would record it as the fence's.
    const previous = process.env.SYNC_CELL_BENCH_UNROUTED
    const bench = { 'x-maplespire-sync-bench-unrouted': '1' }
    try {
      const cell = await landingCellFor({
        // `create_draft` is keyed on the landscape's DEFAULT, so the control at
        // the end needs the lookup to answer; the bypass arms must reach their
        // verdict BEFORE it is ever consulted, which is what makes the control
        // meaningful rather than decorative.
        resolveLandscapeDefault: async () => ({ kind: 'workspace', workspace: { landscapeId: 'L-1', versionId: 'V-default' } }),
      })
      const armedAsk = (pathname: string): Promise<Response> => fetch(`http://127.0.0.1:${cell.port}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bench },
        body: JSON.stringify({ landscapeId: 'L-1', input: { label: 'x' } }),
      })

      process.env.SYNC_CELL_BENCH_UNROUTED = 'on'
      const armed = await armedAsk('/api/ai/tools/create_draft')
      expect(armed.status, 'armed, the tool door runs where it landed').toBe(200)
      await expect(armed.json()).resolves.toEqual({ servedBy: 'landing' })
      expect(armed.headers.get('x-maplespire-sync-route'), 'no routing decision was taken at all').toBeNull()

      // ARMED BUT OFF THE TOOL DOOR: still refused. The bypass is one surface,
      // not a global escape hatch — a routed write must never be reachable
      // through it.
      const elsewhere = await armedAsk('/api/platform/workspace/promote-summary')
      expect(elsewhere.status, 'the bypass leaked off the AI tool door').toBe(400)

      process.env.SYNC_CELL_BENCH_UNROUTED = 'off'
      const unarmed = await armedAsk('/api/ai/tools/create_draft')
      expect(unarmed.status, 'an unarmed cell must REFUSE the header, not ignore it').toBe(400)
      delete process.env.SYNC_CELL_BENCH_UNROUTED
      const absent = await armedAsk('/api/ai/tools/create_draft')
      expect(absent.status, 'and the same with the variable absent entirely').toBe(400)

      // THE CONTROL: without the header, the same door is routed as always, so
      // the bypass is not quietly on for everyone.
      const normal = await post(cell.port, '/api/ai/tools/create_draft', { landscapeId: 'L-1', input: { label: 'x' } })
      expect(normal.headers.get('x-maplespire-sync-route')).toBe('proxied')
    } finally {
      if (previous === undefined) delete process.env.SYNC_CELL_BENCH_UNROUTED
      else process.env.SYNC_CELL_BENCH_UNROUTED = previous
    }
  })

  it('a merge_draft naming an unknown draft falls through to Express — the tool answers its own 404 having written nothing', async () => {
    const cell = await landingCellFor({ resolveMergeParent: async () => ({ kind: 'no-such-draft' }) })
    const answer = await post(cell.port, '/api/ai/tools/merge_draft', { landscapeId: 'L-1', input: { draftId: 'nope' } })
    expect(answer.status).toBe(200)
    await expect(answer.json()).resolves.toEqual({ servedBy: 'landing' })
    expect(cell.received).toEqual([])
  })

  it('the parent lookup does not run before ownership is even decidable', async () => {
    // Ordering, asserted rather than assumed: a cell with ownership disabled is
    // a single-cell deployment, and paying a database round trip per merge to
    // discover that would be a cost this middleware has no reason to add.
    let looked = 0
    const cell = await landingCellFor({
      ownership: () => ownership({ enabled: false }),
      resolveMergeParent: async () => { looked += 1; return { kind: 'no-such-draft' } },
    })
    const answer = await post(cell.port, '/api/landscapes/L-1/drafts/D-9/merge', {})
    expect(answer.status).toBe(200)
    expect(looked, 'the merge parent was looked up on a cell that has no owners at all').toBe(0)
  })
})
