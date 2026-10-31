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

import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { registerSpotlightRoutes, type SpotlightRouteDeps } from './spotlightRoute.js'
import { SpotlightAborted, type RoSpotlightResult } from './spotlight.js'
import type { Queryable } from './types.js'

const KEY = { landscapeId: 'L1', versionId: 'V1' }
const RESULT: RoSpotlightResult = {
  v: 1,
  topHit: { kind: 'system', id: 'o1' },
  sections: [{ kind: 'system', total: 1, totalCapped: false, hits: [{ score: 16, doc: { kind: 'system', id: 'o1', name: 'Payments', extra: {} } }] }],
  coverage: { unavailableKinds: ['adr'], fieldGaps: { diagram: ['desc', 'domain'] } },
}

let server: Server | null = null
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

async function start(overrides: Partial<SpotlightRouteDeps> = {}) {
  const deps = {
    db: {} as Queryable,
    ensureWorkspace: vi.fn(async () => KEY) as SpotlightRouteDeps['ensureWorkspace'],
    search: vi.fn(async () => RESULT),
    freshness: vi.fn(async () => ({ status: 'healthy', projectedGeneration: 42, caughtUp: true, absenceProvable: true })),
    readiness: vi.fn(async () => ({ ready: true as const })),
    ...overrides,
  }
  const app = express()
  app.use(express.json())
  registerSpotlightRoutes(app, deps)
  server = createServer(app)
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const port = (server!.address() as AddressInfo).port
  const post = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/model/spotlight?landscapeId=L1&versionId=V1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  return { deps, post }
}

describe('route modules are registered (QA v2)', () => {
  it('index.ts calls every register…Routes a readModel module exports', async () => {
    const { readdir, readFile } = await import('node:fs/promises')
    const dir = new URL('./', import.meta.url)
    const index = await readFile(new URL('../index.ts', import.meta.url), 'utf8')
    const exported: string[] = []
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      const source = await readFile(new URL(name, dir), 'utf8')
      for (const m of source.matchAll(/export function (register\w+Routes)\(/g)) exported.push(m[1]!)
    }
    expect(exported).toContain('registerSpotlightRoutes') // the control
    for (const fn of exported) expect(index, fn).toMatch(new RegExp(`\\b${fn}\\(app,`))
  })
})

describe('POST /api/model/spotlight', () => {
  it('answers with the ranking plus the workspace, freshness and coverage the client needs to trust it', async () => {
    const { deps, post } = await start()
    const r = await post({ q: 'pay', kinds: ['system', 'diagram'], perKind: 4, vocab: { domains: [['d1', 'Finance']] } })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      v: 1, topHit: { kind: 'system', id: 'o1' }, landscapeId: 'L1', versionId: 'V1',
      projectionGeneration: 42, status: 'healthy', caughtUp: true, absenceProvable: true,
      coverage: { unavailableKinds: ['adr'], fieldGaps: { diagram: ['desc', 'domain'] } },
    })
    const [, key, q, opts] = vi.mocked(deps.search).mock.calls[0]
    expect(key).toEqual(KEY)
    expect(q).toBe('pay')
    expect(opts).toMatchObject({ perKind: 4, kinds: ['system', 'diagram'] })
    expect(opts.vocab.domains.get('d1')).toBe('Finance')
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('passes a projection that is NOT caught up through as such (QA)', async () => {
    const { post } = await start({
      freshness: vi.fn(async () => ({ status: 'building', projectedGeneration: 7, caughtUp: false, absenceProvable: false })),
    })
    const r = await post({ q: 'pay' })
    expect(r.body).toMatchObject({ status: 'building', projectionGeneration: 7, caughtUp: false, absenceProvable: false })
  })

  it('searches nothing when the workspace gate refuses', async () => {
    const { deps, post } = await start({
      ensureWorkspace: vi.fn(async (_req, res) => { res.status(403).json({ error: 'forbidden' }); return undefined }),
    })
    const r = await post({ q: 'pay' })
    expect(r.status).toBe(403)
    expect(deps.search).not.toHaveBeenCalled()
  })

  it('refuses a malformed body with 400 and does not search', async () => {
    const { deps, post } = await start()
    const r = await post({ q: 42 })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/q must be a string/)
    expect(deps.search).not.toHaveBeenCalled()
  })

  it('answers 503 when the database cannot fold like the client, and searches nothing', async () => {
    const { deps, post } = await start({ readiness: vi.fn(async () => ({ ready: false as const, reason: 'fold-mismatch' as const })) })
    const r = await post({ q: 'pay' })
    expect(r).toMatchObject({ status: 503, body: { reason: 'fold-mismatch', retryable: false } })
    expect(deps.search).not.toHaveBeenCalled()
  })

  it('marks a schema still being built as retryable, and checks again after the TTL', async () => {
    let verdict: { ready: true } | { ready: false; reason: 'not-built' } = { ready: false, reason: 'not-built' }
    const readiness = vi.fn(async () => verdict)
    const { post } = await start({ readiness, notReadyTtlMs: 0 })
    expect((await post({ q: 'pay' })).body).toMatchObject({ reason: 'not-built', retryable: true })
    verdict = { ready: true }
    expect((await post({ q: 'pay' })).status).toBe(200)
    // Ready is kept: no further checks.
    await post({ q: 'pay' })
    expect(readiness).toHaveBeenCalledTimes(2)
  })

  it('keeps a not-ready verdict for its TTL instead of probing on every keystroke', async () => {
    const readiness = vi.fn(async () => ({ ready: false as const, reason: 'drift' as const }))
    const { post } = await start({ readiness, notReadyTtlMs: 60_000 })
    await post({ q: 'a' })
    await post({ q: 'ab' })
    await post({ q: 'abc' })
    expect(readiness).toHaveBeenCalledTimes(1)
  })

  it('reports a search failure as a server error', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { post } = await start({ search: vi.fn(async () => { throw new Error('boom') }) })
    expect((await post({ q: 'pay' })).status).toBe(500)
    log.mockRestore()
  })

  it('aborts the search when the client goes away, and logs no error for it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let sawAbort!: () => void
    const aborted = new Promise<void>((resolve) => { sawAbort = resolve })
    // A search that runs until its signal fires, as roSpotlight does between families.
    const search = vi.fn(async (_db, _key, _q, opts: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => opts.signal!.addEventListener('abort', () => resolve(), { once: true }))
      sawAbort()
      throw new SpotlightAborted()
    })
    await start({ search: search as unknown as SpotlightRouteDeps['search'] })
    const port = (server!.address() as AddressInfo).port
    const client = new AbortController()
    const request = fetch(`http://127.0.0.1:${port}/api/model/spotlight`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 'pay' }), signal: client.signal,
    }).catch(() => 'client-aborted')
    await vi.waitFor(() => expect(search).toHaveBeenCalled())
    client.abort()
    await aborted
    expect(await request).toBe('client-aborted')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })
})
