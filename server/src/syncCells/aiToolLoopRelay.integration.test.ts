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

/**
 * THE TOOL-CALL RELAY FROM THE AGENT LOOPS, END TO END THROUGH TWO CELLS AND
 * A REAL POSTGRES.
 *
 * ## What this proves that `aiToolCallRelay.test.ts` cannot
 *
 * That file proves the decision and the hop against a FAKE owner. This one
 * runs the real loops — `runAgentSequence` (`/api/ai/run`) and
 * `runAgentStream` (`/api/ai/chat`) — with a scripted model that decides a
 * bootstrap tool on the cell that does NOT hold the lease, and shows the tool
 * executing on the OWNER through its real direct door, real router, real
 * lookups, real publishers, and the real claim hook; the conversation never
 * moves; the relaying cell opens no scope; and what the model reads back is
 * what the direct door answers.
 *
 * ## The same two cells as the AI tool door suite, plus the auth stack
 *
 * The fixture is `aiToolDoorRoute.integration.test.ts`'s: an `AsyncLocalStorage`
 * stamp tells the process-global bootstrap getter which cell serves a request,
 * and each cell's router and relay read their own coordinator. This suite
 * ALSO mounts `aiBearerBridge` and `requireAuth` in `index.ts`'s order, because
 * the relay forwards the caller's credentials and there is an RBAC arm: a View user's bearer token must be refused the same way by the
 * relay and by the direct door — and, at AUTH=on, the owner must be able to
 * authenticate the forwarded token at all.
 *
 * ## What "the loops" means here
 *
 * `runAgentSequence` and `runAgentStream` ARE the loops; `/api/ai/run` and
 * `/api/ai/chat` are twenty lines over them that resolve the org's provider
 * config and build the context — and the context is built with the same
 * `relayInstallFor(deps, req)` this suite calls, pinned by source in
 * `mutatingRouteCoverage.test.ts`. The HTTP handlers themselves are not driven
 * here: they need a saved org AI config and a provider to talk to, and a mock
 * OpenAI-compatible server is a second protocol to keep honest; that gap is
 * known and accepted.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import express, { type Request } from 'express'
import { Repo } from '@automerge/automerge-repo'
import type { LanguageModel, UIMessage, UIMessageChunk } from 'ai'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIsolatedSchemaDb, type IsolatedSchemaDb } from '../testing/isolatedSchema.js'
import { collectReferencedUrls, documentIdOf } from '../maintenance/workspaceFsck.js'
import { findReadyDocument } from '../automergeRepoCompat.js'
import type { SyncCellOwnership } from './ownership.js'
import type { ResolvedAiConfig } from '../ai/core/config.js'
import type { AiToolCtx } from '../ai/core/toolContext.js'
import type { AiIdentity } from '../ai/core/identity.js'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

type Cell = 'owner' | 'relay'
type PlainDoc = Record<string, unknown> | undefined

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}
const cfg: ResolvedAiConfig = { provider: 'openai-compatible', model: 'mock', baseUrl: null, apiKey: null }
const READ_ONLY_TEXT = 'you have read-only access to this workspace — write tools are unavailable'

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port')
  return address.port
}

/** A `/api/ai/run`-shaped model: ONE tool call, then a closing sentence. */
function sequenceModel(toolName: string, input: unknown): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: [
      {
        content: [{ type: 'tool-call' as const, toolCallId: 'c1', toolName, input: JSON.stringify(input) }],
        finishReason: 'tool-calls' as const,
        usage: USAGE,
        warnings: [],
      },
      { content: [{ type: 'text' as const, text: 'done' }], finishReason: 'stop' as const, usage: USAGE, warnings: [] },
    ],
  }) as unknown as LanguageModel
}

/** A `/api/ai/run`-shaped model that calls ONE tool N times in one round —
 *  a conversation whose reads dominate. */
function repeatedCallModel(toolName: string, input: unknown, times: number): LanguageModel {
  return new MockLanguageModelV3({
    doGenerate: [
      {
        content: Array.from({ length: times }, (_unused, index) => ({
          type: 'tool-call' as const, toolCallId: `c${index}`, toolName, input: JSON.stringify(input),
        })),
        finishReason: 'tool-calls' as const,
        usage: USAGE,
        warnings: [],
      },
      { content: [{ type: 'text' as const, text: 'done' }], finishReason: 'stop' as const, usage: USAGE, warnings: [] },
    ],
  }) as unknown as LanguageModel
}

/** A `/api/ai/chat`-shaped model: the same, streamed. */
function streamModel(toolName: string, input: unknown): LanguageModel {
  const stream = (chunks: LanguageModelV3StreamPart[]) => ({ stream: simulateReadableStream({ chunks }) })
  return new MockLanguageModelV3({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'c1', toolName, input: JSON.stringify(input) },
        { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
      ] as LanguageModelV3StreamPart[]),
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'done' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop', usage: USAGE },
      ] as LanguageModelV3StreamPart[]),
    ],
  }) as unknown as LanguageModel
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

function rid(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('base64url')}`
}

describe.skipIf(!TEST_DATABASE_URL)('B2-10b — a bootstrap tool decided in the agent loop on the RELAY executes on the OWNER (live Postgres, two cells)', () => {
  let db: IsolatedSchemaDb
  let repo: Repo
  let orgId: string
  const cells = new AsyncLocalStorage<Cell>()
  const servers: Server[] = []
  const ports: Record<Cell, number> = { owner: 0, relay: 0 }
  /** Requests that reached each cell's OWN `/api/ai/tools` handler. */
  const local: Record<Cell, number> = { owner: 0, relay: 0 }
  let uninstall: (() => void) | null = null
  const previousAuth = process.env.AUTH
  let logs: string[] = []
  let logSpy: ReturnType<typeof vi.spyOn> | null = null

  let landscapes: typeof import('../landscapes.js')
  let bootstrapScope: typeof import('../bootstrapScope.js')
  let placement: typeof import('../rbac/serverCreationPlacement.js')
  let docScope: typeof import('../rbac/docScope.js')
  let rbacSchema: typeof import('../rbac/schema.js')
  let httpRoutes: typeof import('../ai/adapters/httpRoutes.js')
  let toolContext: typeof import('../ai/core/toolContext.js')
  let toolRegistry: typeof import('../ai/core/toolRegistry.js')
  let agent: typeof import('../ai/core/agent.js')
  let relayModule: typeof import('./aiToolCallRelay.js')
  let tokens: typeof import('../ai/core/tokens.js')
  let identityModule: typeof import('../ai/core/identity.js')

  const routerOwnership = (cell: Cell): SyncCellOwnership => ({
    enabled: true,
    partitionFor: () => 1,
    ownsPartition: () => cell === 'owner',
    owns: () => cell === 'owner',
    fencingToken: () => (cell === 'owner' ? '7' : null),
    resolveOwner: async () => ({ cellId: 'owner', token: '7', partition: 1, advertiseUrl: `http://127.0.0.1:${ports.owner}` }),
    onOwnershipLost: () => () => undefined,
    snapshot: () => ({ cellId: cell, partitionIndex: cell === 'owner' ? 1 : 0 } as never),
    readSnapshot: () => ({ cellId: cell, partitionIndex: cell === 'owner' ? 1 : 0 } as never),
  })
  const routeDeps = (cell: Cell) => ({
    repo,
    rootUrl: 'automerge:unused-fallback-root',
    ownership: () => routerOwnership(cell),
    ownershipRequired: () => true,
  })

  beforeAll(async () => {
    db = await createIsolatedSchemaDb(TEST_DATABASE_URL!, 'ai_tool_loop_relay')
    vi.doMock('../db.js', () => ({ pool: db.pool }))
    vi.resetModules()

    const authSchema = await import('../auth/schema.js')
    rbacSchema = await import('../rbac/schema.js')
    await authSchema.ensureAuthSchema(db.pool)
    await rbacSchema.ensureRbacSchema(db.pool)
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS landscapes (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        default_version_id TEXT,
        org_id             TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await db.pool.query(`
      CREATE TABLE IF NOT EXISTS versions (
        id                TEXT PRIMARY KEY,
        landscape_id      TEXT NOT NULL REFERENCES landscapes(id) ON DELETE CASCADE,
        label             TEXT NOT NULL,
        root_url          TEXT NOT NULL,
        parent_version_id TEXT,
        kind              TEXT NOT NULL DEFAULT 'version',
        status            TEXT NOT NULL DEFAULT 'active',
        base_manifest     JSONB,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    const ownership = await import('./ownership.js')
    await ownership.ensureSyncCellOwnershipSchema(db.pool)
    const readModelSchema = await import('../readModel/schema.js')
    await readModelSchema.ensureReadModelSchema(db.pool)
    const aiSchema = await import('../ai/core/schema.js')
    await aiSchema.ensureAiSchema(db.pool)

    landscapes = await import('../landscapes.js')
    bootstrapScope = await import('../bootstrapScope.js')
    placement = await import('../rbac/serverCreationPlacement.js')
    docScope = await import('../rbac/docScope.js')
    httpRoutes = await import('../ai/adapters/httpRoutes.js')
    toolContext = await import('../ai/core/toolContext.js')
    toolRegistry = await import('../ai/core/toolRegistry.js')
    agent = await import('../ai/core/agent.js')
    relayModule = await import('./aiToolCallRelay.js')
    tokens = await import('../ai/core/tokens.js')
    identityModule = await import('../ai/core/identity.js')
    const { createWorkspaceHttpRouting } = await import('./workspaceHttpRoute.js')
    const { aiBearerBridge } = await import('../ai/adapters/bearerAuth.js')
    const { requireAuth } = await import('../auth/middleware.js')

    orgId = await authSchema.ensureDefaultOrg(db.pool)
    repo = new Repo({})
    new docScope.WorkspaceDocIndex(repo, db.pool)

    uninstall = bootstrapScope.installBootstrapOwnership({
      required: () => true,
      current: () => {
        const cell = cells.getStore()
        if (!cell) return null
        const owns = cell === 'owner'
        return { enabled: true, owns: () => owns, fencingToken: () => (owns ? '7' : null) }
      },
    })

    const cellApp = (cell: Cell): express.Express => {
      const app = express()
      app.use((_request, _response, next) => cells.run(cell, next))
      // `index.ts`'s order: body, bearer bridge, auth gate, router, handlers.
      app.use(express.json())
      app.use('/api', aiBearerBridge())
      app.use('/api', requireAuth())
      app.use(createWorkspaceHttpRouting({ db: db.pool, ownership: () => routerOwnership(cell), ownershipRequired: () => true }))
      app.use('/api/ai/tools', (_request, _response, next) => {
        local[cell] += 1
        next()
      })
      httpRoutes.registerAiHttpRoutes(app, routeDeps(cell))
      return app
    }

    const owner = createServer(cellApp('owner'))
    servers.push(owner)
    ports.owner = await listen(owner)
    const relay = createServer(cellApp('relay'))
    servers.push(relay)
    ports.relay = await listen(relay)
  }, 120_000)

  afterAll(async () => {
    while (servers.length) {
      const server = servers.pop()!
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    uninstall?.()
    placement?.resetServerCreationPlacementForTest()
    if (previousAuth === undefined) delete process.env.AUTH
    else process.env.AUTH = previousAuth
    await db?.teardown()
    vi.doUnmock('../db.js')
    vi.resetModules()
  })

  beforeEach(() => {
    logs = []
    logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)) })
  })
  afterEach(() => {
    logSpy?.mockRestore()
    logSpy = null
  })

  const asOwner = <T,>(fn: () => Promise<T>): Promise<T> => cells.run('owner', fn)
  const onRelay = <T,>(fn: () => Promise<T>): Promise<T> => cells.run('relay', fn)

  /** The context the two loop doors build, on `cell`, for `identity`. */
  async function loopCtx(cell: Cell, landscapeId: string, options: { identity?: AiIdentity | null; versionId?: string; headers?: Record<string, string>; relay?: boolean } = {}): Promise<AiToolCtx> {
    const request = { headers: options.headers ?? {} } as unknown as Request
    return cells.run(cell, () => toolContext.resolveAiToolCtx({
      repo,
      fallbackRootUrl: 'automerge:unused-fallback-root',
      identity: options.identity ?? null,
      landscapeId,
      versionId: options.versionId,
      ...(options.relay === false ? {} : { relay: httpRoutes.relayInstallFor(routeDeps(cell), request) }),
    }))
  }

  async function runLoop(cell: Cell, ctx: AiToolCtx, toolName: string, input: unknown): Promise<unknown> {
    const result = await cells.run(cell, () => agent.runAgentSequence({
      ctx, cfg, prompt: `call ${toolName}`, model: sequenceModel(toolName, input), maxSteps: 2, maxRounds: 1,
    }))
    expect(result.steps[0]?.toolCalls[0]?.toolName).toBe(toolName)
    return result.steps[0]!.toolResults[0]!.output
  }

  async function chatLoop(cell: Cell, ctx: AiToolCtx, toolName: string, input: unknown): Promise<unknown> {
    const userMessage: UIMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', text: `call ${toolName}` }] }
    const chunks = await cells.run(cell, () => collect(agent.runAgentStream({
      ctx, cfg, uiMessages: [userMessage], model: streamModel(toolName, input), maxSteps: 2, maxRounds: 1,
    })))
    const output = chunks.find((chunk): chunk is Extract<UIMessageChunk, { type: 'tool-output-available' }> => chunk.type === 'tool-output-available')
    expect(output, 'the stream carried a tool output').toBeTruthy()
    return output!.output
  }

  async function door(cell: Cell, name: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ status: number; route: string | null; body: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${ports[cell]}/api/ai/tools/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: response.status, route: response.headers.get('x-maplespire-sync-route'), body: (await response.json()) as Record<string, unknown> }
  }

  function relayLines(): Array<Record<string, unknown>> {
    return logs
      .map((line) => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } })
      .filter((line): line is Record<string, unknown> => line?.event === relayModule.AI_TOOL_RELAY_EVENT)
  }

  async function resolvePlain(url: unknown): Promise<PlainDoc> {
    if (typeof url !== 'string' || url.length === 0) return undefined
    return (await findReadyDocument<Record<string, unknown>>(repo, url)).doc()
  }

  async function reachableIds(rootUrl: string): Promise<Set<string>> {
    const root = await resolvePlain(rootUrl)
    const meta = await resolvePlain(root?.modelMetaUrl)
    const registries: PlainDoc[] = []
    for (const shardUrl of (root?.shardUrls as string[] | undefined) ?? []) registries.push(await resolvePlain(shardUrl))
    const referenced = collectReferencedUrls(root, meta, registries)
    return new Set([documentIdOf(rootUrl), ...referenced.map(documentIdOf)])
  }

  async function claimedIds(landscapeId: string, versionId: string): Promise<Set<string>> {
    const { rows } = await db.pool.query<{ document_id: string }>(
      'SELECT document_id FROM automerge_document_workspace WHERE landscape_id = $1 AND version_id = $2',
      [landscapeId, versionId],
    )
    return new Set(rows.map((row) => row.document_id))
  }

  async function rootUrlOf(landscapeId: string, versionId: string): Promise<string> {
    const { rows } = await db.pool.query<{ root_url: string }>(
      'SELECT root_url FROM versions WHERE id = $1 AND landscape_id = $2', [versionId, landscapeId],
    )
    expect(rows, `no versions row for ${versionId}`).toHaveLength(1)
    return rows[0]!.root_url
  }

  /** Same claim as `aiToolDoorRoute.integration.test.ts`: the whole graph, six
   *  documents, claimed. */
  async function expectWholeGraphClaimed(landscapeId: string, versionId: string): Promise<void> {
    const claimed = await claimedIds(landscapeId, versionId)
    expect(claimed).toEqual(await reachableIds(await rootUrlOf(landscapeId, versionId)))
    expect(claimed.size).toBe(6)
  }

  it('run loop on the RELAY calls merge_draft: the merge executes on the OWNER, the snapshot is wholly claimed, the relay opened no scope, and the tool journal says `route: proxied`', async () => {
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'loop merge home', orgId))
    const draft = await asOwner(() => landscapes.createDraft(repo, landscape.id, 'to merge from the loop'))
    expect(draft).not.toBeNull()
    const before = bootstrapScope.bootstrapScopeSnapshot()
    const relayBefore = relayModule.aiToolRelaySnapshot()
    const ownerLocalBefore = local.owner
    const relayLocalBefore = local.relay

    const ctx = await loopCtx('relay', landscape.id)
    const output = await runLoop('relay', ctx, 'merge_draft', { draftId: draft!.id }) as { merged: boolean; snapshotVersionId: string }

    expect(output, JSON.stringify(output)).toMatchObject({ merged: true })
    expect(output.snapshotVersionId).toMatch(/\S/)
    await expectWholeGraphClaimed(landscape.id, output.snapshotVersionId)
    const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM versions WHERE id = $1', [draft!.id])
    expect(rows[0]!.status).toBe('merged')
    // The OWNER's handler ran it; the relay's own handler never saw it; the
    // relay opened no scope and refused none.
    expect(local.owner - ownerLocalBefore, 'the owner’s direct door ran the merge').toBe(1)
    expect(local.relay - relayLocalBefore).toBe(0)
    const after = bootstrapScope.bootstrapScopeSnapshot()
    expect(after.refusedAtOpen - before.refusedAtOpen).toBe(0)
    expect(after.opened - before.opened, 'the owner opened the merge’s scopes').toBeGreaterThanOrEqual(1)
    // THE JOURNAL LINE, on the relaying cell.
    expect(relayLines()).toContainEqual(expect.objectContaining({ tool: 'merge_draft', route: 'proxied', status: 200 }))
    const relayAfter = relayModule.aiToolRelaySnapshot()
    expect(relayAfter.relayed - relayBefore.relayed).toBe(1)
    expect((relayAfter.relayedByTool.merge_draft ?? 0) - (relayBefore.relayedByTool.merge_draft ?? 0)).toBe(1)
  }, 30_000)

  it('chat stream on the RELAY calls create_draft: the draft is forked by the OWNER and wholly claimed; the stream carries the door’s result', async () => {
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'loop chat home', orgId))
    const before = bootstrapScope.bootstrapScopeSnapshot()
    const ownerLocalBefore = local.owner

    const ctx = await loopCtx('relay', landscape.id)
    const output = await chatLoop('relay', ctx, 'create_draft', { label: 'from the chat loop' }) as { draft: { id: string; parentVersionId: string; status: string }; switch: { action: string } }

    expect(output.draft.parentVersionId).toBe(landscape.defaultVersionId)
    expect(output.draft.status).toBe('active')
    expect(output.switch.action).toBe('switch-workspace')
    await expectWholeGraphClaimed(landscape.id, output.draft.id)
    expect(local.owner - ownerLocalBefore).toBe(1)
    expect(bootstrapScope.bootstrapScopeSnapshot().refusedAtOpen - before.refusedAtOpen).toBe(0)
    expect(relayLines()).toContainEqual(expect.objectContaining({ tool: 'create_draft', route: 'proxied', status: 200 }))
  }, 30_000)

  it('run loop on the RELAY calls create_version from INSIDE a draft: placed on the landscape default, forked by the owner', async () => {
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'loop version home', orgId))
    const draft = await asOwner(() => landscapes.createDraft(repo, landscape.id, 'the conversation’s draft'))
    const ownerLocalBefore = local.owner

    // The conversation lives INSIDE the draft; the version is keyed on the
    // landscape default, not on the draft — the fence's key, and the router's.
    const ctx = await loopCtx('relay', landscape.id, { versionId: draft!.id })
    expect(ctx.workspace.versionId).toBe(draft!.id)
    const output = await runLoop('relay', ctx, 'create_version', { label: 'twin from a draft' }) as { version: { id: string } }

    await expectWholeGraphClaimed(landscape.id, output.version.id)
    expect(local.owner - ownerLocalBefore).toBe(1)
    expect(relayLines()).toContainEqual(expect.objectContaining({ tool: 'create_version', route: 'proxied' }))
  }, 30_000)

  it('CONTROL — the same run loop on the OWNER executes in-process: no hop, no journal line, the owner’s door untouched', async () => {
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'owner loop home', orgId))
    const draft = await asOwner(() => landscapes.createDraft(repo, landscape.id, 'owner draft'))
    const relayBefore = relayModule.aiToolRelaySnapshot()
    const ownerLocalBefore = local.owner

    const ctx = await loopCtx('owner', landscape.id)
    const output = await runLoop('owner', ctx, 'merge_draft', { draftId: draft!.id }) as { merged: boolean; snapshotVersionId: string }

    expect(output.merged).toBe(true)
    await expectWholeGraphClaimed(landscape.id, output.snapshotVersionId)
    expect(local.owner - ownerLocalBefore, 'an owner-side loop must not call its own door').toBe(0)
    expect(relayModule.aiToolRelaySnapshot().relayed - relayBefore.relayed).toBe(0)
    expect(relayLines()).toEqual([])
  }, 30_000)

  it('BYTE FOR BYTE — a deterministic answer read through the relay is the direct door’s answer: a merge the parent no longer accepts', async () => {
    // A draft whose parent is no longer the landscape default: `applyMerge`
    // answers `blocked` before opening any scope, deterministically, so the
    // same call through the loop on the relay and through the direct door
    // on the owner must serialise to the same bytes.
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'byte home', orgId))
    const draft = await asOwner(() => landscapes.createDraft(repo, landscape.id, 'orphaned by a default move'))
    const successor = await asOwner(() => landscapes.createVersion(repo, landscape.id, 'the new default'))
    expect(await landscapes.setDefaultVersion(landscape.id, successor!.id)).toBe(true)

    const ownerLocalBefore = local.owner
    const ctx = await loopCtx('relay', landscape.id, { versionId: draft!.parentVersionId! })
    const relayed = await runLoop('relay', ctx, 'merge_draft', { draftId: draft!.id })
    // THE HOP ITSELF, asserted before the control call: a `blocked` merge is
    // answered before any scope opens, so executed LOCALLY it would serialise
    // to the same bytes even with the relay disabled. The byte identity below is only a claim about the relay once
    // the owner is known to have produced the bytes.
    expect(local.owner - ownerLocalBefore, 'the owner’s door produced the relayed answer').toBe(1)
    expect(relayLines()).toContainEqual(expect.objectContaining({ tool: 'merge_draft', route: 'proxied', status: 200 }))
    const direct = await door('owner', 'merge_draft', { landscapeId: landscape.id, versionId: draft!.parentVersionId!, input: { draftId: draft!.id } })

    expect(direct.status, JSON.stringify(direct.body)).toBe(200)
    expect(direct.route).toBe('owner')
    expect(relayed).toMatchObject({ merged: false })
    expect(JSON.stringify(relayed)).toBe(JSON.stringify(direct.body.result))
  }, 30_000)

  it('RBAC — a View user’s bearer is refused by the relay with the direct door’s exact text, LOCALLY: no hop, the owner never asked', async () => {
    process.env.AUTH = 'on'
    try {
      const landscape = await asOwner(() => landscapes.createLandscape(repo, 'viewer home', orgId))
      const draft = await asOwner(() => landscapes.createDraft(repo, landscape.id, 'viewer cannot merge this'))
      // A member with a READ-ONLY team grant on the landscape scope, and a
      // personal access token — the credential the relay would forward.
      const userId = rid('viewer')
      await db.pool.query(`INSERT INTO users (id, issuer, subject, email, name) VALUES ($1, 'test', $1, $2, 'Viewer')`, [userId, `${userId}@example.com`])
      await db.pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, userId])
      const scopeId = await rbacSchema.upsertLandscapeScope(db.pool, orgId, landscape.id)
      const teamId = rid('team')
      await db.pool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'viewers')`, [teamId, orgId])
      await db.pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [teamId, userId])
      await db.pool.query(
        `INSERT INTO team_scope_permissions (team_id, scope_id, resource_type, can_read, can_write) VALUES ($1, $2, '*', true, false)`,
        [teamId, scopeId],
      )
      docScope._clearAllowedWorkspaceKeysCacheForTests()
      const { token } = await tokens.createAiToken(db.pool, { userId, orgId, name: 'viewer pat' })
      const identity = await identityModule.verifyBearerIdentity(db.pool, token)
      expect(identity?.userId).toBe(userId)
      const bearer = { authorization: `Bearer ${token}` }

      const relayBefore = relayModule.aiToolRelaySnapshot()
      const ownerLocalBefore = local.owner
      const ctx = await loopCtx('relay', landscape.id, { identity, headers: bearer })
      expect(ctx.canWrite, 'the viewer is read-only on the relay').toBe(false)

      const failure = await onRelay(() => toolRegistry.executeAiTool(ctx, 'merge_draft', { draftId: draft!.id })).catch((error: unknown) => error)
      expect(failure).toMatchObject({ status: 403, message: READ_ONLY_TEXT })
      // And through the loop, where the model never sees write tools at all:
      // the relayed refusal never becomes a hop either way.
      expect(local.owner - ownerLocalBefore, 'a refused write crossed to the owner').toBe(0)
      expect(relayModule.aiToolRelaySnapshot().relayed - relayBefore.relayed).toBe(0)

      // THE DIRECT DOOR, on the owner, with the same bearer: the same text.
      const direct = await door('owner', 'merge_draft', { landscapeId: landscape.id, input: { draftId: draft!.id } }, bearer)
      expect(direct.status).toBe(403)
      expect(direct.body.error).toBe(READ_ONLY_TEXT)
      expect((failure as Error).message).toBe(direct.body.error)
      const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM versions WHERE id = $1', [draft!.id])
      expect(rows[0]!.status, 'nothing was merged').toBe('active')
    } finally {
      if (previousAuth === undefined) delete process.env.AUTH
      else process.env.AUTH = previousAuth
      docScope._clearAllowedWorkspaceKeysCacheForTests()
    }
  }, 30_000)

  it('RBAC — a WRITER’s bearer crosses with the call: at AUTH=on the owner authenticates the forwarded token and merges', async () => {
    // The hop carries the caller's credentials or it carries nothing the
    // owner will accept: at AUTH=on the owner's `requireAuth` answers 401 to
    // a bare hop, and this arm is what turns a dropped `authorization` header
    // into a red test rather than a 401 the model reads in production.
    process.env.AUTH = 'on'
    try {
      const landscape = await asOwner(() => landscapes.createLandscape(repo, 'writer home', orgId))
      const draft = await asOwner(() => landscapes.createDraft(repo, landscape.id, 'writer merges this'))
      const userId = rid('writer')
      await db.pool.query(`INSERT INTO users (id, issuer, subject, email, name) VALUES ($1, 'test', $1, $2, 'Writer')`, [userId, `${userId}@example.com`])
      await db.pool.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, userId])
      const scopeId = await rbacSchema.upsertLandscapeScope(db.pool, orgId, landscape.id)
      const teamId = rid('team')
      await db.pool.query(`INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'writers')`, [teamId, orgId])
      await db.pool.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [teamId, userId])
      await db.pool.query(
        `INSERT INTO team_scope_permissions (team_id, scope_id, resource_type, can_read, can_write) VALUES ($1, $2, '*', true, true)`,
        [teamId, scopeId],
      )
      docScope._clearAllowedWorkspaceKeysCacheForTests()
      const { token } = await tokens.createAiToken(db.pool, { userId, orgId, name: 'writer pat' })
      const identity = await identityModule.verifyBearerIdentity(db.pool, token)
      const ownerLocalBefore = local.owner

      const ctx = await loopCtx('relay', landscape.id, { identity, headers: { authorization: `Bearer ${token}` } })
      expect(ctx.canWrite).toBe(true)
      const output = await runLoop('relay', ctx, 'merge_draft', { draftId: draft!.id }) as { merged?: boolean; error?: string; snapshotVersionId: string }

      expect(output, JSON.stringify(output)).toMatchObject({ merged: true })
      await expectWholeGraphClaimed(landscape.id, output.snapshotVersionId)
      expect(local.owner - ownerLocalBefore, 'the owner authenticated the forwarded bearer and ran the merge').toBe(1)
      expect(relayLines()).toContainEqual(expect.objectContaining({ tool: 'merge_draft', route: 'proxied', status: 200 }))

      // CONTROL for the arm itself: the same hop with NO credentials is what
      // the owner refuses — so the green above is the bearer's doing. A REAL
      // draft, or the decision keeps an unknown one local and nothing hops.
      const bareDraft = await asOwner(() => landscapes.createDraft(repo, landscape.id, 'bare hop'))
      const bare = await loopCtx('relay', landscape.id, { identity })
      const refused = await runLoop('relay', bare, 'merge_draft', { draftId: bareDraft!.id }) as { error?: string }
      expect(refused.error, 'a credential-less hop must be refused by the owner’s auth gate').toMatch(/401|[Aa]uthentication|workspace owner answered 401/)
      const { rows: bareRows } = await db.pool.query<{ status: string }>('SELECT status FROM versions WHERE id = $1', [bareDraft!.id])
      expect(bareRows[0]!.status, 'the credential-less hop merged nothing').toBe('active')
    } finally {
      if (previousAuth === undefined) delete process.env.AUTH
      else process.env.AUTH = previousAuth
      docScope._clearAllowedWorkspaceKeysCacheForTests()
    }
  }, 30_000)

  it('a merge_draft naming a draft that does not exist executes where it landed and answers its own 404 — no hop', async () => {
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'unknown draft loop home', orgId))
    const ownerLocalBefore = local.owner
    const ctx = await loopCtx('relay', landscape.id)
    const output = await runLoop('relay', ctx, 'merge_draft', { draftId: 'nope' })
    expect(output).toEqual({ error: 'no draft with id "nope"' })
    expect(local.owner - ownerLocalBefore).toBe(0)
    expect(relayLines()).toEqual([])
  }, 30_000)

  it('THE READ HOP, MEASURED (B2-10d3): a twenty-read conversation on the RELAY makes ZERO hops, and the same on the owner too', async () => {
    // WHY THIS ARM EXISTS. The door places EVERY tool name, and the loop asks
    // the same extractor — so without a filter a conversation would hop once
    // per tool call, reads included. `executeAiTool` therefore asks the relay
    // only for `mode: 'write'` tools.
    //
    // Measured on this fixture, same twenty reads:
    //   shipped        relay 0 hops / 34.7 ms   owner 0 hops / 10.2 ms
    //   filter removed relay 20 hops / 81.9 ms  owner 0 hops / 13.0 ms
    // So the filter is worth ~47 ms per twenty reads — about 2.4 ms a hop —
    // over LOOPBACK, between two Express apps in one process. That figure is a
    // FLOOR, not the production cost: a real hop crosses a network and a TLS
    // session. The decision rests on the COUNT (twenty round trips a
    // conversation buys nothing: a read needs no lease) rather than on the
    // milliseconds, which is why the floor is enough to decide with.
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'read hop home', orgId))
    const READS = 20

    const measure = async (cell: Cell): Promise<{ hops: number; ms: number; results: number }> => {
      const ctx = await loopCtx(cell, landscape.id)
      const before = relayModule.aiToolRelaySnapshot()
      const started = performance.now()
      const result = await cells.run(cell, () => agent.runAgentSequence({
        ctx, cfg, prompt: 'list the drafts, twenty times', model: repeatedCallModel('list_drafts', {}, READS),
        maxSteps: 2, maxRounds: 1,
      }))
      const ms = performance.now() - started
      return {
        hops: relayModule.aiToolRelaySnapshot().relayed - before.relayed,
        ms,
        results: result.steps[0]?.toolResults.length ?? 0,
      }
    }

    const relayRun = await measure('relay')
    const ownerRun = await measure('owner')

    // VACUITY FIRST: the conversation really made twenty tool calls, and they
    // really answered. Without this the zero below would be free.
    expect(relayRun.results, 'the scripted conversation made twenty tool calls').toBe(READS)
    expect(ownerRun.results).toBe(READS)
    // THE MEASUREMENT. Zero hops on both cells — the relay because the loop
    // filters reads out, the owner because it owns the workspace anyway.
    expect(relayRun.hops, 'a read was relayed from the loop — the write-only filter is gone').toBe(0)
    expect(ownerRun.hops, 'the control: the owner never hops').toBe(0)
    expect(relayLines().filter((line) => line.tool === 'list_drafts'), 'no relay journal line for a read').toEqual([])
  }, 60_000)

  it('THE SHAPE THE MUTANT REPRODUCES — the same loop on the relay WITHOUT the capability opens the scope locally and hands the model B2-5d’s 503 as a tool error', async () => {
    const landscape = await asOwner(() => landscapes.createLandscape(repo, 'bare loop home', orgId))
    const draft = await asOwner(() => landscapes.createDraft(repo, landscape.id, 'refused in the loop'))
    const before = bootstrapScope.bootstrapScopeSnapshot()
    const ownerLocalBefore = local.owner

    const ctx = await loopCtx('relay', landscape.id, { relay: false })
    const output = await runLoop('relay', ctx, 'merge_draft', { draftId: draft!.id }) as { error?: string }

    expect(output.error).toMatch(/this cell does not own/)
    const after = bootstrapScope.bootstrapScopeSnapshot()
    expect(after.refusedAtOpen - before.refusedAtOpen).toBe(1)
    expect(after.refusedAtOpenByReason['not-owner'] - before.refusedAtOpenByReason['not-owner']).toBe(1)
    expect(local.owner - ownerLocalBefore).toBe(0)
    const { rows } = await db.pool.query<{ status: string }>('SELECT status FROM versions WHERE id = $1', [draft!.id])
    expect(rows[0]!.status).toBe('active')
  }, 30_000)
})
