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
import type { AddressInfo } from 'node:net'
import express from 'express'
import { Repo } from '@automerge/automerge-repo'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiIdentity } from '../core/identity.js'
import type { AiToolCtx, ResolveCtxOpts } from '../core/toolContext.js'

/**
 * V0-07: fine scopes, end to end through the bearer bridge AND the real tool
 * door (`POST /api/ai/tools/:name`). The bridge decides routes; the tool
 * registry's `mode` decides tools, so a `model:read` token reaches the tool
 * door but only its read tools execute. The tool context is an in-memory
 * Automerge workspace (no Postgres) — only workspace resolution is replaced.
 */

const verifyBearerIdentity = vi.fn<(db: unknown, token: string) => Promise<AiIdentity | null>>()
const holder = vi.hoisted(() => ({
  ctx: null as null | ((opts: { identity: AiIdentity | null }) => Promise<unknown>),
}))

vi.mock('../../db.js', () => ({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } }))
vi.mock('../core/identity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/identity.js')>()
  return { ...actual, verifyBearerIdentity: (db: unknown, token: string) => verifyBearerIdentity(db, token) }
})
vi.mock('../core/toolContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/toolContext.js')>()
  return { ...actual, resolveAiToolCtx: (opts: ResolveCtxOpts) => holder.ctx!(opts) }
})

const { aiBearerBridge } = await import('./bearerAuth.js')
const { registerAiHttpRoutes } = await import('./httpRoutes.js')
const { ModelSession } = await import('../core/modelOps.js')

function identity(scopes: string[]): AiIdentity {
  return { userId: 'u1', orgId: 'o1', isPlatformAdmin: false, via: 'pat', scopes, tokenId: 't1' }
}

let server: Server
let base: string
let repo: Repo
let rootUrl: string
/** What the fake `versions` lookup answers for the current workspace. */
let workspaceIsDraft = false

async function seed(): Promise<string> {
  const model = repo.create<Record<string, unknown>>({
    objects: {}, connections: {}, groups: {}, domains: {}, tagSnapshots: {}, decisionRecords: {},
  })
  await model.whenReady()
  const shard = repo.create<Record<string, unknown>>({ diagrams: {} })
  await shard.whenReady()
  const root = repo.create<Record<string, unknown>>({ modelUrl: model.url, shardUrls: [shard.url] })
  await root.whenReady()
  return root.url
}

beforeAll(async () => {
  repo = new Repo({})
  rootUrl = await seed()
  const db = {
    query: async (sql: string) =>
      /FROM versions/i.test(sql) && workspaceIsDraft ? { rows: [{ kind: 'draft' }], rowCount: 1 } : { rows: [], rowCount: 0 },
  } as unknown as Pool
  holder.ctx = async (opts): Promise<AiToolCtx> => ({
    repo,
    db,
    identity: opts.identity,
    workspace: { landscapeId: 'default', versionId: 'v1' },
    rootUrl,
    canWrite: true,
    orgId: 'o1',
    userId: 'u1',
    userLabel: 'T',
    session: new ModelSession(repo, rootUrl),
    assertWriteOn: async () => {},
  })

  const app = express()
  app.use(express.json())
  app.use('/api', aiBearerBridge())
  registerAiHttpRoutes(app, { repo, rootUrl })
  // Anything the AI routes do not serve answers 200, so a non-200 there can
  // only come from the bridge.
  app.use((req, res) => {
    res.json({ auth: req.auth ?? null })
  })
  server = createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  verifyBearerIdentity.mockReset()
  workspaceIsDraft = false
})

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: 'Bearer bvr_test_token', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

const writeTool = (name = 'Created by test') =>
  call('POST', '/api/ai/tools/create_model_object', { input: { type: 'system', name } })
const readTool = () => call('POST', '/api/ai/tools/list_model_objects', { input: {} })

describe('a model:read PAT cannot write', () => {
  beforeEach(() => verifyBearerIdentity.mockResolvedValue(identity(['model:read'])))

  it('a write route answers 403 insufficient_scope', async () => {
    const r = await call('POST', '/api/landscapes/default/drafts', { label: 'x' })
    expect(r.status).toBe(403)
    expect(r.body?.error).toBe('insufficient_scope')
    expect((await call('POST', '/api/ai/run', { prompt: 'x' })).status).toBe(403)
  })

  it('a write tool answers 403', async () => {
    const r = await writeTool()
    expect(r.status).toBe(403)
    expect(String(r.body?.error)).toMatch(/scope/)
  })

  it('a read route and a read tool answer 200', async () => {
    expect((await call('GET', '/api/model/objects/search?q=x')).status).toBe(200)
    const r = await readTool()
    expect(r.status).toBe(200)
    expect(r.body?.result).toMatchObject({ objects: expect.any(Array) })
  })
})

describe('model:write can write', () => {
  it('runs a write tool', async () => {
    verifyBearerIdentity.mockResolvedValue(identity(['model:write']))
    const r = await writeTool('Written by model:write')
    expect(r.status).toBe(200)
    verifyBearerIdentity.mockResolvedValue(identity(['model:read']))
    const listed = (await readTool()).body?.result as { objects: { name: string }[] }
    expect(listed.objects.map((o) => o.name)).toContain('Written by model:write')
  })
})

describe('drafts:write writes model content only inside a draft', () => {
  it('is refused on a non-draft workspace and allowed in a draft', async () => {
    verifyBearerIdentity.mockResolvedValue(identity(['drafts:write']))
    expect((await writeTool('in live')).status).toBe(403)
    workspaceIsDraft = true
    expect((await writeTool('in draft')).status).toBe(200)
  })
})

describe('mcp keeps today behaviour', () => {
  it('runs read and write tools', async () => {
    verifyBearerIdentity.mockResolvedValue(identity(['mcp']))
    expect((await readTool()).status).toBe(200)
    expect((await writeTool('via mcp')).status).toBe(200)
    expect((await call('GET', '/api/model/objects/search?q=x')).status).toBe(403)
  })
})

describe('POST /api/me/ai-tokens validates scopes against the catalog', () => {
  it('answers 400 on an unknown scope before touching the database', async () => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.auth = { userId: 'u1', orgId: 'o1', isPlatformAdmin: false, epoch: 1 }
      next()
    })
    registerAiHttpRoutes(app, { repo, rootUrl })
    const s = createServer(app)
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/me/ai-tokens`
    const mint = (body: unknown) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    try {
      const bad = await mint({ name: 't', scopes: ['model:read', 'admin'] })
      expect(bad.status).toBe(400)
      expect(await bad.json()).toMatchObject({ error: 'unknown_scope', unknown: ['admin'] })
      expect((await mint({ name: 't', scopes: 'mcp' })).status).toBe(400)
      expect((await mint({ name: 't', scopes: [] })).status).toBe(400)
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
  })
})
