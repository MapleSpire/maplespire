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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'
import { Repo } from '@automerge/automerge-repo'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SyncCellOwnership } from './ownership.js'
import {
  AI_TOOL_RELAY_EVENT,
  aiToolRelayMetricSamples,
  aiToolRelaySnapshot,
  relayPlacedAiToolCall,
  resetAiToolRelayCountersForTest,
  type AiToolRelayCapability,
} from './aiToolCallRelay.js'
import { requestWorkspaceOwnerJson, SYNC_HTTP_ROUTED_HEADER } from './httpProxy.js'
import { decideWorkspaceRoute } from './workspaceHttpRoute.js'
import { AI_TOOL_DOORS } from './workspaceRouteExtractors.js'
import { executeAiTool, listAiTools } from '../ai/core/toolRegistry.js'
import { buildAiSdkTools } from '../ai/core/agent.js'
import { AiToolError, type AiToolCtx } from '../ai/core/toolContext.js'
import { ModelSession } from '../ai/core/modelOps.js'
import { relayInstallFor } from '../ai/adapters/httpRoutes.js'
import type { Request } from 'express'

/**
 * THE TOOL-CALL RELAY, WITHOUT A DATABASE.
 *
 * `aiToolLoopRelay.integration.test.ts` drives the real loops through two
 * cells against Postgres. This file drives the DECISION and the HOP against a
 * fake owner, so every branch the integration suite cannot afford to stage —
 * an owner that stalls after its headers, an owner that answers prose, a hop
 * aborted mid-flight, a credential that must never reach a log line — has an
 * arm that can go red on its own.
 */

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port')
  return address.port
}

interface Seen {
  url: string
  method: string
  headers: IncomingMessage['headers']
  body: string
}

/** A fake owner: records what reached it, answers what it is told to. */
function fakeOwner(answer: (seen: Seen, response: ServerResponse) => void): { server: Server; seen: Seen[] } {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const record: Seen = { url: request.url ?? '', method: request.method ?? '', headers: request.headers, body }
      seen.push(record)
      answer(record, response)
    })
  })
  return { server, seen }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('x-maplespire-sync-route', 'owner')
  response.end(JSON.stringify(body))
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

const PARENT = { landscapeId: 'L1', versionId: 'V0' }
const CREDENTIALS = { cookie: 'session=s3cret-cookie', authorization: 'Bearer bvr_s3cret-token' }

function relayTo(ownerPort: number, overrides: Partial<AiToolRelayCapability> = {}): AiToolRelayCapability {
  return {
    ownership: () => ownership({
      resolveOwner: async () => ({ cellId: 'owner', token: '7', partition: 1, advertiseUrl: `http://127.0.0.1:${ownerPort}` }),
    }),
    ownershipRequired: () => true,
    authorize: async () => true,
    credentials: CREDENTIALS,
    alreadyRouted: false,
    resolvers: {
      resolveWorkspace: async (_db, requested) => requested,
      resolveMergeParent: async () => ({ kind: 'workspace', workspace: PARENT }),
      resolveLandscapeDefault: async () => ({ kind: 'workspace', workspace: PARENT }),
    },
    ...overrides,
  }
}

const noDb = null as unknown as Pool
const WORKSPACE = { landscapeId: 'L1', versionId: 'V9' }

describe('relayPlacedAiToolCall — the decision and the hop', () => {
  const servers: Server[] = []
  let logs: string[]
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetAiToolRelayCountersForTest()
    logs = []
    logSpy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)) })
    warnSpy = vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { logs.push(String(line)) })
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
  })

  afterEach(async () => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  const relayLine = (route: string) => logs
    .map((entry) => { try { return JSON.parse(entry) as Record<string, unknown> } catch { return null } })
    .find((entry) => entry?.event === AI_TOOL_RELAY_EVENT && entry.route === route)

  it('carries a placed creation to the owner’s direct door — path, body, credentials and the routed marker — and returns the door’s answer', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: { draft: { id: 'D-new' } } }))
    servers.push(owner.server)
    const port = await listen(owner.server)

    const outcome = await relayPlacedAiToolCall({
      db: noDb, relay: relayTo(port), tool: 'create_draft', workspace: WORKSPACE, rawInput: { label: 'via the loop' },
    })

    expect(outcome).toEqual({ kind: 'relayed', status: 200, route: 'owner', body: { result: { draft: { id: 'D-new' } } } })
    expect(owner.seen).toHaveLength(1)
    const hop = owner.seen[0]!
    expect(hop.method).toBe('POST')
    expect(hop.url).toBe('/api/ai/tools/create_draft')
    // The body is the DOOR's body: the ctx's canonical workspace at the top
    // level, the model's raw input under `input` — what the router's extractor
    // reads on the owner, so the owner's router says `owner` and executes.
    expect(JSON.parse(hop.body)).toEqual({ landscapeId: 'L1', versionId: 'V9', input: { label: 'via the loop' } })
    expect(hop.headers['content-type']).toBe('application/json')
    expect(hop.headers.cookie).toBe(CREDENTIALS.cookie)
    expect(hop.headers.authorization).toBe(CREDENTIALS.authorization)
    expect(hop.headers[SYNC_HTTP_ROUTED_HEADER]).toBe('landing-cell')
    expect(hop.headers['accept-encoding'], 'the owner must not compress a JSON answer this reads').toBeUndefined()

    // The journal line, and the counter beside it.
    const line = logs.map((entry) => { try { return JSON.parse(entry) } catch { return null } })
      .find((entry) => entry?.event === AI_TOOL_RELAY_EVENT)
    expect(line).toMatchObject({ tool: 'create_draft', route: 'proxied', status: 200, assignedPartition: 1, localPartition: 0 })
    expect(aiToolRelaySnapshot()).toMatchObject({ relayed: 1, relayedByTool: { create_draft: 1 }, refusedByRouter: 0, ownerUnavailable: 0, malformed: 0 })
  })

  it('NEVER writes a credential into a log line', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    await relayPlacedAiToolCall({ db: noDb, relay: relayTo(port), tool: 'create_draft', workspace: WORKSPACE, rawInput: { label: 'x' } })
    // And through the failure paths too, which log more.
    await relayPlacedAiToolCall({
      db: noDb, relay: relayTo(port, { ownership: () => ownership({ resolveOwner: async () => null }) }),
      tool: 'create_draft', workspace: WORKSPACE, rawInput: { label: 'x' },
    })
    const everything = logs.join('\n')
    expect(everything).not.toContain('s3cret')
    expect(everything).not.toContain('Bearer')
  })

  it('places the merge on the draft’s PARENT through the router’s own lookup, keyed on the ctx landscape and input.draftId', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: { merged: true, snapshotVersionId: 'S1' } }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const lookups: Array<[string, string]> = []
    const owns = vi.fn(() => false)
    const authorize = vi.fn(async () => true)
    const relay = relayTo(port, {
      ownership: () => ownership({
        owns,
        resolveOwner: async () => ({ cellId: 'owner', token: '7', partition: 1, advertiseUrl: `http://127.0.0.1:${port}` }),
      }),
      authorize,
      resolvers: {
        resolveWorkspace: async (_db, requested) => requested,
        resolveMergeParent: async (_db, landscapeId, draftId) => { lookups.push([landscapeId, draftId]); return { kind: 'workspace', workspace: PARENT } },
        resolveLandscapeDefault: async () => { throw new Error('the merge must not read the landscape default') },
      },
    })

    const outcome = await relayPlacedAiToolCall({
      db: noDb, relay, tool: 'merge_draft', workspace: WORKSPACE, rawInput: { draftId: 'D9', resolutions: { 'objects:o1': 'draft' } },
    })

    expect(outcome).toMatchObject({ kind: 'relayed', status: 200 })
    expect(lookups).toEqual([['L1', 'D9']])
    // `owns` was asked about the PARENT — the lease the fence keys the merge on
    // — and so was `authorize`: read access is checked on the workspace the
    // merge WRITES, which the caller never named, not on the ctx workspace.
    expect(owns).toHaveBeenCalledWith(PARENT)
    expect(authorize).toHaveBeenCalledWith(PARENT)
    expect(authorize).not.toHaveBeenCalledWith(WORKSPACE)
    expect(owner.seen[0]!.url).toBe('/api/ai/tools/merge_draft')
    expect(JSON.parse(owner.seen[0]!.body).input).toEqual({ draftId: 'D9', resolutions: { 'objects:o1': 'draft' } })
  })

  it('a name the DOOR does not serve executes where it landed — nothing reaches the owner', async () => {
    // The generic entry places every name the door serves — and the relay
    // PERCENT-ENCODES the name it presents, so even `nested/name` reaches the
    // door as one segment and is placed. What is left local is a name that
    // cannot be presented at all, and a workspace whose key a routing hint may
    // not carry. The relay is asked per CALL; which calls are worth a hop is
    // `executeAiTool`'s question (write tools only).
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const cases: Array<[string, string, { landscapeId: string; versionId: string }]> = [
      ['an empty name is not a door', '', WORKSPACE],
      ['a landscape id carrying a slash', 'update_model_object', { landscapeId: 'a/b', versionId: 'V-1' }],
      ['a version id carrying a NUL', 'update_model_object', { landscapeId: 'L-1', versionId: `V${String.fromCharCode(0)}1` }],
    ]
    for (const [label, tool, workspace] of cases) {
      const outcome = await relayPlacedAiToolCall({ db: noDb, relay: relayTo(port), tool, workspace, rawInput: {} })
      expect(outcome, label).toEqual({ kind: 'local', reason: 'not-placed' })
    }
    expect(owner.seen).toHaveLength(0)
    expect(aiToolRelaySnapshot().relayed).toBe(0)
  })

  it('EVERY tool the registry serves hops, and the three doors keep their own key', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const hopped: string[] = []
    for (const def of listAiTools()) {
      const outcome = await relayPlacedAiToolCall({
        db: noDb, relay: relayTo(port), tool: def.name, workspace: WORKSPACE, rawInput: { label: 'x', draftId: 'D9' },
      })
      if (outcome.kind === 'relayed') hopped.push(def.name)
    }
    expect(hopped.sort(), 'every registry tool is placed by the door').toEqual(listAiTools().map((d) => d.name).sort())
    // And the three bootstrap names are still keyed by a LOOKUP, not by the
    // body: their `resolvers` are the only ones this fixture makes answer, so
    // a fork silently re-keyed on `{workspace}` would show up as a hop that
    // never asked them.
    expect([...AI_TOOL_DOORS.keys()].every((name) => hopped.includes(name))).toBe(true)
  })

  it('on the OWNER a placed tool executes locally; with ownership disabled or absent-and-not-required too', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const cases: Array<[string, Partial<AiToolRelayCapability>, string]> = [
      ['owner', { ownership: () => ownership({ owns: () => true }) }, 'owner'],
      ['disabled', { ownership: () => ownership({ enabled: false }) }, 'ownership-disabled'],
      ['absent, not required', { ownership: () => null, ownershipRequired: () => false }, 'ownership-absent'],
      ['no such draft', { resolvers: { resolveMergeParent: async () => ({ kind: 'no-such-draft' }) } }, 'no-such-draft'],
      ['no landscape default', { resolvers: { resolveLandscapeDefault: async () => ({ kind: 'unresolved' }) } }, 'unresolved-landscape'],
    ]
    for (const [label, overrides, reason] of cases) {
      const tool = reason === 'no-such-draft' ? 'merge_draft' : 'create_draft'
      const outcome = await relayPlacedAiToolCall({
        db: noDb, relay: relayTo(port, overrides), tool, workspace: WORKSPACE, rawInput: { label: 'x', draftId: 'D9' },
      })
      expect(outcome, label).toEqual({ kind: 'local', reason })
    }
    expect(owner.seen).toHaveLength(0)
  })

  it('answers the router’s OWN refusals, status and text verbatim, without a hop', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const cases: Array<[string, Partial<AiToolRelayCapability>, string, number, string]> = [
      ['warming up', { ownership: () => null, ownershipRequired: () => true }, 'create_draft', 503, 'sync-cell ownership warming up'],
      ['unplaceable draft', { resolvers: { resolveMergeParent: async () => ({ kind: 'unplaceable', reason: 'not-a-draft' }) } }, 'merge_draft', 404, 'draft not found or not mergeable'],
      ['workspace not found', { resolvers: { resolveWorkspace: async () => null, resolveLandscapeDefault: async () => ({ kind: 'workspace', workspace: PARENT }) } }, 'create_draft', 404, 'workspace not found'],
      ['forbidden on the placed workspace', { authorize: async () => false }, 'merge_draft', 403, 'forbidden'],
      ['already routed', { alreadyRouted: true }, 'create_draft', 503, 'workspace owner unavailable'],
      ['no owner route', { ownership: () => ownership({ resolveOwner: async () => null }) }, 'create_draft', 503, 'workspace owner unavailable'],
      ['owner is this cell', { ownership: () => ownership({ resolveOwner: async () => ({ cellId: 'landing-cell', token: '7', partition: 1, advertiseUrl: `http://127.0.0.1:${port}` }) }) }, 'create_draft', 503, 'workspace owner unavailable'],
    ]
    for (const [label, overrides, tool, status, error] of cases) {
      const outcome = await relayPlacedAiToolCall({
        db: noDb, relay: relayTo(port, overrides), tool, workspace: WORKSPACE, rawInput: { label: 'x', draftId: 'D9' },
      })
      expect(outcome, label).toEqual({ kind: 'refused', status, error })
    }
    expect(owner.seen).toHaveLength(0)
    expect(aiToolRelaySnapshot().refusedByRouter).toBe(cases.length)
  })

  it('a placement chain that THROWS answers the middleware’s own 503 `workspace routing unavailable` — counted, logged, and never a hop', async () => {
    // Every lookup in the chain throws on a database failure rather than
    // answering null, and `resolveOwner` can reject on a Redis command. Let
    // escape, that would reach the loop's generic catch as a 500 "AI request
    // failed" with no line and no counter, breaking "throws only on abort".
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const throwing: Array<[string, Partial<AiToolRelayCapability>, string]> = [
      ['the merge parent lookup', { resolvers: { resolveMergeParent: async () => { throw new Error('timeout exceeded when trying to connect') } } }, 'merge_draft'],
      ['the landscape default lookup', { resolvers: { resolveLandscapeDefault: async () => { throw new Error('connection terminated') } } }, 'create_draft'],
      ['the canonicaliser', { resolvers: { resolveWorkspace: async () => { throw new Error('pool exhausted') }, resolveLandscapeDefault: async () => ({ kind: 'workspace', workspace: PARENT }) } }, 'create_version'],
      ['the authorisation', { authorize: async () => { throw new Error('allowedWorkspaceKeys failed') } }, 'create_draft'],
      ['the owner resolution', { ownership: () => ownership({ resolveOwner: async () => { throw new Error('redis command timed out') } }) }, 'create_draft'],
    ]
    for (const [label, overrides, tool] of throwing) {
      const outcome = await relayPlacedAiToolCall({
        db: noDb, relay: relayTo(port, overrides), tool, workspace: WORKSPACE, rawInput: { label: 'x', draftId: 'D9' },
      })
      expect(outcome, label).toEqual({ kind: 'refused', status: 503, error: 'workspace routing unavailable' })
    }
    expect(owner.seen, 'a chain that could not decide must not hop').toHaveLength(0)
    expect(aiToolRelaySnapshot().routingUnavailable).toBe(throwing.length)
    expect(errorSpy).toHaveBeenCalledTimes(throwing.length)
    expect(relayLine('routing-unavailable')).toMatchObject({ tool: 'merge_draft', status: 503 })
    expect(aiToolRelayMetricSamples()[1]!.values).toContainEqual({ value: throwing.length, labels: { outcome: 'routing-unavailable' } })
  })

  it('a connection cut AFTER the request was sent is `owner-unavailable`, not an owner that answered nonsense; a non-JSON error keeps its status', async () => {
    const cut = createServer((_request, response) => {
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.write('{"result":{"draft":')
      setTimeout(() => response.destroy(), 20)
    })
    servers.push(cut)
    const cutPort = await listen(cut)
    expect(await relayPlacedAiToolCall({
      db: noDb, relay: relayTo(cutPort), tool: 'create_draft', workspace: WORKSPACE, rawInput: { label: 'x' },
    })).toEqual({ kind: 'owner-unavailable', reason: 'answer-cut' })

    // An nginx-style HTML 503 in front of the owner: the STATUS is the fact,
    // and it survives; only a 2xx that is not JSON is `malformed`.
    const html = fakeOwner((_seen, response) => { response.statusCode = 503; response.setHeader('Content-Type', 'text/html'); response.end('<html>upstream down</html>') })
    servers.push(html.server)
    const htmlPort = await listen(html.server)
    expect(await relayPlacedAiToolCall({
      db: noDb, relay: relayTo(htmlPort), tool: 'create_draft', workspace: WORKSPACE, rawInput: { label: 'x' },
    })).toEqual({ kind: 'relayed', status: 503, route: null, body: null })
  })

  it('the decision the relay acts on IS the middleware’s — same function, same deps shape', async () => {
    // A source pin, because the parity is the design: the relay must call
    // `decideWorkspaceRoute` and never re-derive the chain; a second copy
    // would drift from the middleware's.
    const source = await readFile(new URL('./aiToolCallRelay.ts', import.meta.url), 'utf8')
    expect(source).toContain('decideWorkspaceRoute(parsed, {')
    expect(source).toContain('parseWorkspaceHttpRoute(path, \'POST\', body)')
    expect(source).not.toMatch(/resolveOwner\(/)
    expect(source).not.toMatch(/\.owns\(/)
    expect(typeof decideWorkspaceRoute).toBe('function')
  })

  it('an owner that cannot be reached is `owner-unavailable`, within the connect bound', async () => {
    // A port nobody listens on: the connection is refused at once.
    const probe = createServer()
    const closedPort = await listen(probe)
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const started = Date.now()
    const outcome = await relayPlacedAiToolCall({
      db: noDb, relay: relayTo(closedPort, { connectTimeoutMs: 2_000 }), tool: 'create_draft', workspace: WORKSPACE, rawInput: { label: 'x' },
    })
    expect(outcome).toEqual({ kind: 'owner-unavailable', reason: 'connection-error' })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(aiToolRelaySnapshot().ownerUnavailable).toBe(1)
  })

  it('an owner that sends its headers and then STALLS is bounded by the whole-answer deadline — the one place this differs from the proxy — and the socket is torn down', async () => {
    let closed = 0
    const owner = createServer((request, response) => {
      request.on('close', () => { closed += 1 })
      response.statusCode = 200
      response.setHeader('Content-Type', 'application/json')
      response.write('{"result":')
      // never ends
    })
    servers.push(owner)
    const port = await listen(owner)
    const started = Date.now()
    const outcome = await relayPlacedAiToolCall({
      db: noDb, relay: relayTo(port, { timeoutMs: 300 }), tool: 'create_draft', workspace: WORKSPACE, rawInput: { label: 'x' },
    })
    expect(outcome).toEqual({ kind: 'owner-unavailable', reason: 'answer-timeout' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
    expect(Date.now() - started).toBeLessThan(5_000)
    // ASSERTED, not left to the afterEach hook's own timeout: a hop that
    // expired but kept its socket would hold the owner's request open until
    // the hook itself timed out.
    await vi.waitFor(() => expect(closed, 'the stalled owner saw the request closed').toBe(1))
  })

  it('an owner that answers prose, or a 2xx too large to be a tool answer, is `malformed`', async () => {
    const prose = fakeOwner((_seen, response) => { response.statusCode = 200; response.end('<html>owner</html>') })
    servers.push(prose.server)
    const prosePort = await listen(prose.server)
    expect(await relayPlacedAiToolCall({
      db: noDb, relay: relayTo(prosePort), tool: 'create_draft', workspace: WORKSPACE, rawInput: { label: 'x' },
    })).toEqual({ kind: 'malformed', reason: 'not-json' })

    const huge = fakeOwner((_seen, response) => { response.statusCode = 200; response.end(JSON.stringify({ result: 'x'.repeat(4096) })) })
    servers.push(huge.server)
    const hugePort = await listen(huge.server)
    const answer = await requestWorkspaceOwnerJson({
      advertiseUrl: `http://127.0.0.1:${hugePort}`, path: '/api/ai/tools/create_draft', body: {}, headers: {}, sourceCellId: 'landing-cell', maxAnswerBytes: 1024,
    })
    expect(answer).toEqual({ kind: 'malformed', reason: 'too-large' })
    expect(aiToolRelaySnapshot().malformed).toBe(1)
  })

  it('a hop aborted by the loop’s signal throws the signal’s reason and destroys the request; an already-aborted signal never sends one', async () => {
    let arrived = 0
    let closed = 0
    const owner = createServer((request, response) => {
      arrived += 1
      request.on('close', () => { closed += 1 })
      // never answers; the abort must tear it down
      void response
    })
    servers.push(owner)
    const port = await listen(owner)

    const controller = new AbortController()
    const reason = new Error('round watchdog fired')
    const pending = relayPlacedAiToolCall({
      db: noDb, relay: relayTo(port), tool: 'create_draft', workspace: WORKSPACE, rawInput: { label: 'x' }, signal: controller.signal,
    })
    await vi.waitFor(() => expect(arrived).toBe(1))
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    await vi.waitFor(() => expect(closed).toBe(1))
    // Counted and journaled although it throws: the loop's catch drops the
    // reason, so this line is the only trace a sent-but-unanswered hop leaves.
    expect(aiToolRelaySnapshot().aborted).toBe(1)
    expect(relayLine('aborted')).toMatchObject({ tool: 'create_draft', assignedPartition: 1, localPartition: 0 })

    const dead = new AbortController()
    dead.abort(reason)
    await expect(relayPlacedAiToolCall({
      db: noDb, relay: relayTo(port), tool: 'create_draft', workspace: WORKSPACE, rawInput: { label: 'x' }, signal: dead.signal,
    })).rejects.toBe(reason)
    expect(arrived, 'an already-aborted signal must not produce a request').toBe(1)
  })

  it('the abort listener is REMOVED when the hop settles — a round-long signal must not retain a finished hop', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const controller = new AbortController()
    const added: EventListenerOrEventListenerObject[] = []
    const removed: EventListenerOrEventListenerObject[] = []
    const signal = controller.signal
    const originalAdd = signal.addEventListener.bind(signal)
    const originalRemove = signal.removeEventListener.bind(signal)
    signal.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'abort') added.push(listener)
      return originalAdd(type, listener, options as AddEventListenerOptions)
    }) as typeof signal.addEventListener
    signal.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      if (type === 'abort') removed.push(listener)
      return originalRemove(type, listener, options as EventListenerOptions)
    }) as typeof signal.removeEventListener

    await relayPlacedAiToolCall({ db: noDb, relay: relayTo(port), tool: 'create_draft', workspace: WORKSPACE, rawInput: { label: 'x' }, signal })
    expect(added).toHaveLength(1)
    // By IDENTITY — a removal of a different closure removes nothing.
    expect(removed).toEqual(added)
  })

  it('exposes the counters as Prometheus samples, by tool and by failure outcome', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    await relayPlacedAiToolCall({ db: noDb, relay: relayTo(port), tool: 'create_version', workspace: WORKSPACE, rawInput: { label: 'x' } })
    await relayPlacedAiToolCall({ db: noDb, relay: relayTo(port, { alreadyRouted: true }), tool: 'create_version', workspace: WORKSPACE, rawInput: { label: 'x' } })
    const samples = aiToolRelayMetricSamples()
    expect(samples.map((sample) => sample.name)).toEqual(['maplespire_ai_tool_relays_total', 'maplespire_ai_tool_relay_failures_total'])
    expect(samples[0]!.values).toEqual([{ value: 1, labels: { tool: 'create_version' } }])
    expect(samples[1]!.values).toContainEqual({ value: 1, labels: { outcome: 'refused-by-router' } })
  })
})

describe('relayInstallFor — what the two loop doors hand the context', () => {
  const deps = { repo: {} as never, rootUrl: 'automerge:x', ownership: () => null, ownershipRequired: () => true }
  const request = (headers: Record<string, string | string[] | undefined>): Request => ({ headers } as unknown as Request)

  it('forwards EXACTLY the two credential headers, and nothing else the request carries', () => {
    const install = relayInstallFor(deps, request({
      cookie: 'session=abc',
      authorization: 'Bearer bvr_x',
      'x-forwarded-for': '10.0.0.1',
      'x-request-id': 'r1',
      host: 'landing.internal',
      'content-type': 'application/json',
    }))
    expect(install?.credentials).toEqual({ cookie: 'session=abc', authorization: 'Bearer bvr_x' })
    expect(install?.alreadyRouted).toBe(false)
    expect(install?.ownership).toBe(deps.ownership)
    expect(install?.ownershipRequired).toBe(deps.ownershipRequired)
  })

  it('an absent or blank credential is not forwarded as an empty header', () => {
    expect(relayInstallFor(deps, request({ cookie: '' }))?.credentials).toEqual({})
    expect(relayInstallFor(deps, request({}))?.credentials).toEqual({})
  })

  it('a request that arrived routed installs a relay that refuses to hop again', () => {
    expect(relayInstallFor(deps, request({ [SYNC_HTTP_ROUTED_HEADER]: 'other-cell' }))?.alreadyRouted).toBe(true)
  })

  it('a process with no coordinator installs nothing — every tool executes where it lands, as before B2-10b', () => {
    expect(relayInstallFor({ repo: {} as never, rootUrl: 'automerge:x' }, request({ cookie: 'session=abc' }))).toBeUndefined()
  })

  it('ownershipRequired defaults to false when the adapter is not told otherwise', () => {
    const install = relayInstallFor({ repo: {} as never, rootUrl: 'automerge:x', ownership: () => null }, request({}))
    expect(install?.ownershipRequired()).toBe(false)
  })
})

describe('executeAiTool with the relay installed — what the loop’s tool result becomes', () => {
  const servers: Server[] = []
  let logSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetAiToolRelayCountersForTest()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    logSpy.mockRestore()
    warnSpy.mockRestore()
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  })

  async function emptyWorkspace(repo: Repo): Promise<string> {
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

  async function ctxWith(relay: AiToolRelayCapability | undefined, canWrite = true): Promise<AiToolCtx> {
    const repo = new Repo({})
    const rootUrl = await emptyWorkspace(repo)
    return {
      repo,
      db: noDb,
      identity: null,
      workspace: WORKSPACE,
      rootUrl,
      canWrite,
      orgId: null,
      userId: null,
      userLabel: 'Test AI',
      session: new ModelSession(repo, rootUrl),
      assertWriteOn: async () => {},
      ...(relay ? { relay } : {}),
    }
  }

  it('a 2xx from the owner is the door’s `result`, and the local session is invalidated after a relayed write', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: { draft: { id: 'D-new' }, switch: { action: 'switch-workspace' } } }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const ctx = await ctxWith(relayTo(port))
    const invalidate = vi.spyOn(ctx.session, 'invalidate')
    const result = await executeAiTool(ctx, 'create_draft', { label: 'via the loop' })
    expect(result).toEqual({ draft: { id: 'D-new' }, switch: { action: 'switch-workspace' } })
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(owner.seen).toHaveLength(1)
  })

  it('the RAW input crosses, not the parsed one — a key the schema strips still reaches the owner, which validates what the model produced', async () => {
    // The local parse is a fast-fail, not the validation of record: the
    // owner's `executeAiTool` parses again, on the same bytes the direct door
    // would have received. A relay that forwarded `parsed.data` would strip
    // unknown keys on this cell and hand the owner a shape the model never
    // produced.
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const ctx = await ctxWith(relayTo(port))
    await executeAiTool(ctx, 'create_draft', { label: 'raw', note: 'the schema does not know me' })
    expect(JSON.parse(owner.seen[0]!.body).input).toEqual({ label: 'raw', note: 'the schema does not know me' })
  })

  it('a View user is refused LOCALLY with the direct door’s text — nothing hops, so the owner is never asked', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const ctx = await ctxWith(relayTo(port), false)
    await expect(executeAiTool(ctx, 'merge_draft', { draftId: 'D9' })).rejects.toMatchObject({
      status: 403,
      message: 'you have read-only access to this workspace — write tools are unavailable',
    })
    expect(owner.seen, 'a refused write must not cross a cell').toHaveLength(0)
    expect(aiToolRelaySnapshot().relayed).toBe(0)
  })

  it('an invalid input is refused LOCALLY at 400 — the owner is never asked', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const ctx = await ctxWith(relayTo(port))
    await expect(executeAiTool(ctx, 'create_draft', { label: '' })).rejects.toMatchObject({ status: 400 })
    expect(owner.seen).toHaveLength(0)
  })

  it('the owner’s refusal is the tool’s error, status and text verbatim — a View user the OWNER refuses reads the same 403', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 403, { error: 'you have read-only access to this workspace — write tools are unavailable' }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const ctx = await ctxWith(relayTo(port))
    const failure = await executeAiTool(ctx, 'merge_draft', { draftId: 'D9' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AiToolError)
    expect(failure).toMatchObject({ status: 403, message: 'you have read-only access to this workspace — write tools are unavailable' })
  })

  it('the owner’s 404 and the route-loop 503 read as the door reads them', async () => {
    const answers = [
      [404, { error: 'no draft with id "D9"' }],
      [503, { error: 'workspace owner unavailable', retryable: true }],
      [503, { error: 'this sync cell does not own the workspace', code: 'sync-cell-not-owner', reason: 'fence-mismatch' }],
    ] as const
    for (const [status, body] of answers) {
      const owner = fakeOwner((_seen, response) => json(response, status, body))
      servers.push(owner.server)
      const port = await listen(owner.server)
      const ctx = await ctxWith(relayTo(port))
      await expect(executeAiTool(ctx, 'merge_draft', { draftId: 'D9' })).rejects.toMatchObject({ status, message: body.error })
    }
  })

  it('a 2xx without `result`, an unreachable owner and a prose answer are errors with the proxy’s wordings — never a silent `undefined` result', async () => {
    const noResult = fakeOwner((_seen, response) => json(response, 200, { ok: true }))
    servers.push(noResult.server)
    const noResultPort = await listen(noResult.server)
    await expect(executeAiTool(await ctxWith(relayTo(noResultPort)), 'create_draft', { label: 'x' }))
      .rejects.toMatchObject({ status: 502, message: 'workspace owner answered malformed' })

    const probe = createServer()
    const closedPort = await listen(probe)
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const unreachableCtx = await ctxWith(relayTo(closedPort))
    const invalidate = vi.spyOn(unreachableCtx.session, 'invalidate')
    await expect(executeAiTool(unreachableCtx, 'create_draft', { label: 'x' }))
      .rejects.toMatchObject({ status: 503, message: 'workspace owner unavailable' })
    // A write whose hop failed after it MAY have been sent does not keep its
    // local cache: the owner may have applied it.
    expect(invalidate).toHaveBeenCalledTimes(1)

    const prose = fakeOwner((_seen, response) => { response.statusCode = 200; response.end('nope') })
    servers.push(prose.server)
    const prosePort = await listen(prose.server)
    await expect(executeAiTool(await ctxWith(relayTo(prosePort)), 'create_draft', { label: 'x' }))
      .rejects.toMatchObject({ status: 502, message: 'workspace owner answered malformed' })
  })

  it('the router’s own refusal is the tool’s error too — and so is a placement chain that throws, at the middleware’s wording', async () => {
    const ctx = await ctxWith(relayTo(1, { ownership: () => null, ownershipRequired: () => true }))
    await expect(executeAiTool(ctx, 'create_draft', { label: 'x' })).rejects.toMatchObject({ status: 503, message: 'sync-cell ownership warming up' })
    const throwing = await ctxWith(relayTo(1, { resolvers: { resolveLandscapeDefault: async () => { throw new Error('pg: timeout exceeded when trying to connect') } } }))
    await expect(executeAiTool(throwing, 'create_draft', { label: 'x' })).rejects.toMatchObject({ status: 503, message: 'workspace routing unavailable' })
    // An HTML 503 from a proxy in front of the owner reads as the owner's 503.
    const html = fakeOwner((_seen, response) => { response.statusCode = 503; response.end('<html>down</html>') })
    servers.push(html.server)
    const htmlPort = await listen(html.server)
    await expect(executeAiTool(await ctxWith(relayTo(htmlPort)), 'create_draft', { label: 'x' })).rejects.toMatchObject({ status: 503, message: 'workspace owner answered 503' })
  })

  it('without the capability every tool executes where it landed — the shape the direct door and /mcp keep', async () => {
    const ctx = await ctxWith(undefined)
    // `create_draft` would need a database here; a read proves the path.
    const stats = await executeAiTool(ctx, 'get_model_stats', {})
    expect(stats).toBeTruthy()
    expect(aiToolRelaySnapshot().relayed).toBe(0)
  })

  it('the SDK tool built by the loop hands its abort signal down: an aborted round sends nothing to the owner', async () => {
    const owner = fakeOwner((_seen, response) => json(response, 200, { result: {} }))
    servers.push(owner.server)
    const port = await listen(owner.server)
    const ctx = await ctxWith(relayTo(port))
    const tools = buildAiSdkTools(ctx)
    const controller = new AbortController()
    controller.abort(new Error('client went away'))
    const answer = await tools.create_draft!.execute!({ label: 'x' }, { toolCallId: 'c1', messages: [], abortSignal: controller.signal })
    expect(answer).toMatchObject({ error: expect.any(String) })
    expect(owner.seen, 'a hop for an aborted round').toHaveLength(0)
  })
})
