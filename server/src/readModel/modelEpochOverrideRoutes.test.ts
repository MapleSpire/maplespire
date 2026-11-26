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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

/**
 * G4-16f: the OVERRIDE-ROW routes over real HTTP. The gate
 * is mocked (its own suites pin it); what is pinned here is the ROUTE's
 * order and answers: a reader is refused 403 BEFORE the body is parsed (so a
 * reader with a malformed body still gets 403, never 400); a writer with a
 * bad body gets 400; a writer with a good one reaches the resolve, as itself.
 */
const role = { value: 'writer' as 'reader' | 'writer' | 'none' }
const resolveMock = vi.fn()
const listMock = vi.fn()
const userActorsMock = vi.fn()
/** The request's session (null: AUTH off, no `req.auth`). */
const session = { userId: 'marie' as string | null }

vi.mock('../rbac/workspaceGate.js', () => ({
  canonicalWorkspaceKey: async (_pool: unknown, key: { landscapeId: string; versionId: string }) =>
    (key.landscapeId === 'missing' ? null : key),
  checkWorkspaceAccess: async () => role.value !== 'none',
  canWriteVersion: async () => role.value === 'writer',
  requireVersionWrite: async (_pool: unknown, _req: unknown, res: express.Response) => {
    if (role.value === 'writer') return true
    res.status(403).json({ error: 'write access required' })
    return false
  },
}))
vi.mock('./modelEpochOverrides.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./modelEpochOverrides.js')>()),
  resolveOverrides: (...a: unknown[]) => resolveMock(...a),
  listOverridesForActors: (...a: unknown[]) => listMock(...a),
  overrideActorsOfUser: (...a: unknown[]) => userActorsMock(...a),
}))

const BATCH = '0b4e1f3a-6c1d-4d43-9a2e-5b8f7c6d5e4f'

async function start(): Promise<{ url: string; queries: string[]; close: () => Promise<void> }> {
  const { registerModelEpochOverrideRoutes } = await import('./modelEpochOverrideRoutes.js')
  const { route } = await import('../routeErrors.js')
  const queries: string[] = []
  const pool = {
    connect: async () => ({ query: async (sql: string) => { queries.push(sql); return { rows: [], rowCount: 0 } }, release: () => {} }),
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (session.userId) req.auth = { userId: session.userId, orgId: null, isPlatformAdmin: false, epoch: 1 } as never
    next()
  })
  registerModelEpochOverrideRoutes(app, {
    pool: pool as never,
    workspaceOf: (req) => ({ landscapeId: String(req.query.landscapeId ?? 'l'), versionId: 'v' }),
    route: (handler) => route<express.Request, express.Response>(handler),
  })
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    queries,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const post = (url: string, body: unknown, query = '') =>
  fetch(`${url}/api/model/epoch-overrides/resolve${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

describe('override routes over HTTP', () => {
  beforeEach(() => {
    role.value = 'writer'
    resolveMock.mockReset().mockResolvedValue({ reapplied: 1, dismissed: 0, reverted: 0 })
    listMock.mockReset().mockResolvedValue([])
    userActorsMock.mockReset().mockImplementation(async (_db: unknown, _key: unknown, _user: string, asked: string[]) => [...asked, 'bb'])
    session.userId = 'marie'
  })
  afterEach(() => { vi.clearAllMocks() })

  it('a READER is refused 403 — with a malformed body too: the write check comes before the parse', async () => {
    role.value = 'reader'
    const { url, close } = await start()
    try {
      expect((await post(url, { batchId: 'not-a-uuid' })).status).toBe(403)
      expect((await post(url, { batchId: BATCH, reapplied: ['r1'], dismissed: [] })).status).toBe(403)
      expect(resolveMock).not.toHaveBeenCalled()
    } finally { await close() }
  })

  it('a WRITER with a bad body gets 400, and nothing is resolved', async () => {
    const { url, queries, close } = await start()
    try {
      expect((await post(url, { batchId: 'not-a-uuid' })).status).toBe(400)
      expect((await post(url, { batchId: BATCH, reapplied: 'r1' })).status).toBe(400)
      expect((await post(url, { revert: 42 })).status).toBe(400)
      expect(resolveMock).not.toHaveBeenCalled()
      expect(queries).toEqual([])
    } finally { await close() }
  })

  it('a WRITER with a good body resolves in one transaction, as itself', async () => {
    const { url, queries, close } = await start()
    try {
      const res = await post(url, { batchId: BATCH, reapplied: ['r1'], dismissed: ['r2'] })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ reapplied: 1, dismissed: 0, reverted: 0 })
      expect(resolveMock).toHaveBeenCalledWith(expect.anything(), { landscapeId: 'l', versionId: 'v' },
        { batchId: BATCH, reapplied: ['r1'], dismissed: ['r2'] }, 'marie')
      expect(queries).toEqual(['BEGIN', 'COMMIT'])
    } finally { await close() }
  })

  it('an unknown workspace is 404; no read access is 403 on both routes', async () => {
    const { url, close } = await start()
    try {
      expect((await post(url, { batchId: BATCH }, '?landscapeId=missing')).status).toBe(404)
      role.value = 'none'
      expect((await post(url, { batchId: BATCH })).status).toBe(403)
      expect((await fetch(`${url}/api/model/epoch-overrides?actors=aa`)).status).toBe(403)
      role.value = 'reader'
      const list = await fetch(`${url}/api/model/epoch-overrides?actors=aa,ZZ`)
      expect(list.status).toBe(200)
      // A reader: listed by its recorded actors, nothing recorded.
      expect(userActorsMock).toHaveBeenCalledWith(expect.anything(), { landscapeId: 'l', versionId: 'v' }, 'marie', ['aa'], false)
      expect(listMock).toHaveBeenCalledWith(expect.anything(), { landscapeId: 'l', versionId: 'v' }, ['aa', 'bb'])
    } finally { await close() }
  })

  it('a WRITER records; the user is the session\'s, never a parameter; at most 256 asked actors', async () => {
    const { url, close } = await start()
    try {
      expect((await fetch(`${url}/api/model/epoch-overrides?actors=aa&user=paul&userId=paul`)).status).toBe(200)
      expect(userActorsMock).toHaveBeenLastCalledWith(expect.anything(), { landscapeId: 'l', versionId: 'v' }, 'marie', ['aa'], true)
      const many = Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(4, '0'))
      expect((await fetch(`${url}/api/model/epoch-overrides?actors=${many.join(',')}`)).status).toBe(200)
      expect(userActorsMock.mock.lastCall![3]).toEqual(many.slice(0, 256))
    } finally { await close() }
  })

  it('signed in, the rows of every actor the USER\'s tabs asked with; with no session (AUTH off), the asked actors only', async () => {
    const { url, close } = await start()
    try {
      expect((await fetch(`${url}/api/model/epoch-overrides?actors=aa`)).status).toBe(200)
      expect(listMock).toHaveBeenLastCalledWith(expect.anything(), { landscapeId: 'l', versionId: 'v' }, ['aa', 'bb'])
      session.userId = null
      userActorsMock.mockClear()
      expect((await fetch(`${url}/api/model/epoch-overrides?actors=aa`)).status).toBe(200)
      expect(userActorsMock).not.toHaveBeenCalled()
      expect(listMock).toHaveBeenLastCalledWith(expect.anything(), { landscapeId: 'l', versionId: 'v' }, ['aa'])
    } finally { await close() }
  })
})
