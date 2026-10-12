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

import type { RequestHandler } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { createSingleFlightWorkspaceRouteResolver, getSharedWorkspaceRouteResolver } from './workspaceRoute.js'
import { createWorkspaceHttpRouting } from './workspaceHttpRoute.js'
import { relayPlacedAiToolCall } from './aiToolCallRelay.js'
import type { SyncCellOwnership } from './ownership.js'

const workspace = { landscapeId: 'L-route-cache', versionId: 'V-route-cache' }
const rows = () => ({ rows: [{ landscape_id: workspace.landscapeId, version_id: workspace.versionId }] })
const ownHere = () => ({ enabled: true, owns: () => true }) as SyncCellOwnership

function request(middleware: RequestHandler): Promise<{ status: number; body?: unknown }> {
  return new Promise(resolve => {
    let status = 200
    const response = {
      headersSent: false,
      setHeader: vi.fn(),
      status: (value: number) => { status = value; return response },
      json: (body: unknown) => resolve({ status, body }),
    }
    middleware({ originalUrl: `/api/automerge/root?landscapeId=${workspace.landscapeId}&versionId=${workspace.versionId}`,
      method: 'GET', headers: {} } as never, response as never, () => resolve({ status }))
  })
}

describe('shared canonical route cache', () => {
  it('shares one resolver within one pool and isolates other pools', async () => {
    const a = { query: vi.fn(async () => rows()) }
    const b = { query: vi.fn(async () => ({ rows: [] })) }
    const first = getSharedWorkspaceRouteResolver(a as never)
    const second = getSharedWorkspaceRouteResolver(a as never)
    expect(first).toBe(second)
    expect(first).not.toBe(getSharedWorkspaceRouteResolver(b as never))
    await expect(first(a as never, workspace)).resolves.toEqual(workspace)
    await expect(second(a as never, workspace)).resolves.toEqual(workspace)
    expect(a.query).toHaveBeenCalledTimes(1)
    await expect(getSharedWorkspaceRouteResolver(b as never)(b as never, workspace)).resolves.toBeNull()
    expect(b.query).toHaveBeenCalledTimes(1)
    expect(() => first(b as never, workspace), 'pool identity must be checked even for a warm key').toThrow('different pool')
  })

  it('the default HTTP middleware performs one cold SQL canonicalization then reuses it across 100 admissions', async () => {
    const db = { query: vi.fn(async () => rows()) }
    const middleware = createWorkspaceHttpRouting({ db: db as never, ownership: ownHere, authorize: async () => true })
    expect(await request(middleware)).toEqual({ status: 200 })
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('FROM versions'), [workspace.landscapeId, workspace.versionId])
    for (let index = 0; index < 100; index += 1) expect(await request(middleware)).toEqual({ status: 200 })
    expect(db.query).toHaveBeenCalledTimes(1)
    const wsResolver = getSharedWorkspaceRouteResolver(db as never)
    await expect(wsResolver(db as never, workspace)).resolves.toEqual(workspace)
    expect(db.query).toHaveBeenCalledTimes(1)
    expect(wsResolver.invalidate(workspace.landscapeId)).toBe(1)
    await request(middleware)
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('AI tool-call canonicalization uses the same pool resolver as HTTP', async () => {
    const db = { query: vi.fn(async () => rows()) }
    const middleware = createWorkspaceHttpRouting({ db: db as never, ownership: ownHere, authorize: async () => true })
    await request(middleware)
    const call = () => relayPlacedAiToolCall({
      db: db as never, tool: 'create_draft', workspace, rawInput: {},
      relay: { ownership: ownHere, ownershipRequired: () => true, authorize: async () => true,
        credentials: {}, alreadyRouted: false,
        resolvers: { resolveLandscapeDefault: async () => ({ kind: 'workspace', workspace }) } },
    })
    await expect(call()).resolves.toEqual({ kind: 'local', reason: 'owner' })
    expect(db.query).toHaveBeenCalledTimes(1)
    getSharedWorkspaceRouteResolver(db as never).invalidate(workspace.landscapeId)
    await expect(call()).resolves.toEqual({ kind: 'local', reason: 'owner' })
    expect(db.query).toHaveBeenCalledTimes(2)
  })

  it('a non-owner HTTP admission reads readSnapshot without invoking legacy snapshot', async () => {
    const snapshot = vi.fn(() => { throw new Error('mutating observation was used') })
    const readSnapshot = vi.fn(() => ({ cellId: 'landing', partitionIndex: 0 }))
    const middleware = createWorkspaceHttpRouting({ db: { query: vi.fn(async () => rows()) } as never,
      ownership: () => ({ enabled: true, owns: () => false, snapshot, readSnapshot,
        resolveOwner: async () => null, partitionFor: () => 1 }) as unknown as SyncCellOwnership,
      authorize: async () => true })
    expect((await request(middleware)).status).toBe(503)
    expect(readSnapshot).toHaveBeenCalledOnce()
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('whole-cache invalidation removes every key and prevents an older flight from repopulating it', async () => {
    let release!: (value: typeof workspace) => void
    const old = new Promise<typeof workspace>(done => { release = done })
    const base = vi.fn().mockResolvedValueOnce(workspace).mockReturnValueOnce(old).mockResolvedValue(workspace)
    const resolver = createSingleFlightWorkspaceRouteResolver(base)
    const pool = {} as never
    await resolver(pool, workspace)
    const pending = resolver(pool, { ...workspace, versionId: 'current' })
    expect(resolver.invalidateAll()).toBe(1)
    const fresh = resolver(pool, { ...workspace, versionId: 'current' })
    expect(base).toHaveBeenCalledTimes(3)
    release({ ...workspace, versionId: 'old' })
    await pending
    await fresh
    await expect(resolver(pool, { ...workspace, versionId: 'current' })).resolves.toEqual(workspace)
    expect(base).toHaveBeenCalledTimes(3)
    await resolver(pool, workspace)
    expect(base).toHaveBeenCalledTimes(4)
  })
})
