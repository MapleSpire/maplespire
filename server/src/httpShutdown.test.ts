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
 * T-DIAGDEF (4) — the shutdown's `http` step over REAL sockets: an HTTP server
 * with an SSE route, a slow write route and a never-answering route, the
 * Automerge-style WebSocket upgrade (noServer, `closeAutomergeSockets`), and
 * clients holding each kind of connection open — the browser a manual test left on
 * the workspace (`server.shutdown_trace outcome=forced-exit`, 30 s).
 *
 * Driven through `runGracefulShutdown` itself, with `closeHttpServer` as its
 * `closeHttp` and the real Automerge socket closure as its `drainAutomerge`,
 * so the trace judged is the one `index.ts` logs.
 */

import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { Agent, createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

import { closeAutomergeSockets } from './automergeDrain.js'
import { closeHttpServer, LongLivedResponses } from './httpShutdown.js'
import { runGracefulShutdown } from './serverShutdown.js'

interface Stack {
  server: Server
  wss: WebSocketServer
  streams: LongLivedResponses
  port: number
  writes: string[]
}

async function startStack(): Promise<Stack> {
  const streams = new LongLivedResponses()
  const writes: string[] = []
  const server = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
      res.write('event: ready\ndata: {}\n\n')
      const untrack = streams.track(res)
      res.once('close', untrack)
      return
    }
    if (req.url === '/write') {
      // A write in flight when the signal lands: it must reach its response.
      setTimeout(() => {
        writes.push('applied')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
      }, 400)
      return
    }
    if (req.url === '/stuck') return // never answers
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
  })
  server.keepAliveTimeout = 60_000
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, wss, streams, port: (server.address() as AddressInfo).port, writes }
}

function get(port: number, path: string, agent: Agent): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent, method: path === '/write' ? 'POST' : 'GET' }, resolve)
    req.on('error', reject)
    req.end()
  })
}

function shutdownWith(stack: Stack, options: { graceMs?: number } = {}) {
  const lines: string[] = []
  const exits: number[] = []
  const noop = () => Promise.resolve()
  const done = runGracefulShutdown('SIGTERM', {
    stopIntake: () => undefined,
    stopStaticProjector: () => undefined,
    stopMaintenanceIntake: () => undefined,
    drainMaintenance: noop,
    closeDurableHeadsDecoder: noop,
    drainAutomerge: () => closeAutomergeSockets(stack.wss),
    stopChangeHub: noop,
    closeHttp: async () => {
      const outcome = await closeHttpServer(stack.server, { longLived: stack.streams, graceMs: options.graceMs, log: (l) => lines.push(l) })
      lines.push(JSON.stringify({ event: 'server.http_closed', ...outcome }))
    },
    stopOwnership: noop,
    shutdownAutomerge: noop,
    stopRedis: noop,
    endPools: noop,
    exit: (code) => { exits.push(code) },
    log: (line) => lines.push(line),
    forcedExitMs: 8_000,
  })
  return { done, lines, exits }
}

const traceOf = (lines: string[]) => JSON.parse(lines.find((l) => l.includes('server.shutdown_trace'))!) as {
  outcome: string; totalMs: number; steps: { step: string; endMs?: number }[]
}

describe('T-DIAGDEF (4) — the http step ends with a browser connected', () => {
  let stack: Stack | null = null
  afterEach(async () => {
    if (stack?.server.listening) stack.server.closeAllConnections()
    stack?.server.close()
    stack = null
  })

  it('a WebSocket, an SSE stream, an idle keep-alive and a write in flight: complete in well under the deadline, the write applied', async () => {
    stack = await startStack()
    const agent = new Agent({ keepAlive: true, maxSockets: 8 })
    // An idle keep-alive connection (a finished request on a kept socket).
    const idle = await get(stack.port, '/ping', agent)
    idle.resume()
    await once(idle, 'end')
    // The SSE stream an open page holds.
    const sse = await get(stack.port, '/events', agent)
    sse.resume()
    const sseEnded = once(sse, 'end')
    // The Automerge socket.
    const ws = new WebSocket(`ws://127.0.0.1:${stack.port}/automerge`)
    await once(ws, 'open')
    const wsClosed = once(ws, 'close')
    // The write in flight at the signal.
    const write = get(stack.port, '/write', agent)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(stack.streams.size).toBe(1)

    const startedAt = performance.now()
    const { done, lines, exits } = shutdownWith(stack)
    await done
    const elapsed = performance.now() - startedAt

    const trace = traceOf(lines)
    expect(trace.outcome).toBe('complete')
    expect(exits).toEqual([0])
    expect(elapsed).toBeLessThan(3_000)
    expect(trace.steps.find((s) => s.step === 'http')?.endMs).toBeDefined()
    // Nothing was cut: the write reached its response and was applied.
    const written = await write
    expect(written.statusCode).toBe(200)
    expect(stack.writes).toEqual(['applied'])
    const closed = JSON.parse(lines.find((l) => l.includes('server.http_closed'))!)
    expect(closed.endedStreams).toBe(1)
    expect(closed.forcedConnections).toBe(false)
    // The page's EventSource sees its stream END (it reconnects elsewhere) and
    // the WebSocket the restart close code.
    await sseEnded
    const [code] = await wsClosed
    expect(code).toBe(1012)
    agent.destroy()
  })

  it('a request that never answers is cut at the grace period, said in the log, and the shutdown still completes', async () => {
    stack = await startStack()
    const agent = new Agent({ keepAlive: true })
    const stuck = get(stack.port, '/stuck', agent).catch((error: Error) => error)
    await new Promise((resolve) => setTimeout(resolve, 50))

    const startedAt = performance.now()
    const { done, lines, exits } = shutdownWith(stack, { graceMs: 300 })
    await done
    const elapsed = performance.now() - startedAt

    expect(traceOf(lines).outcome).toBe('complete')
    expect(exits).toEqual([0])
    expect(elapsed).toBeGreaterThanOrEqual(280)
    expect(elapsed).toBeLessThan(2_000)
    expect(lines.some((l) => l.includes('server.http_close_forced'))).toBe(true)
    expect(await stuck).toBeInstanceOf(Error)
    agent.destroy()
  })

  it('a stream reaching its headers after the step is refused (closing), never left open', () => {
    const streams = new LongLivedResponses()
    expect(streams.closing).toBe(false)
    streams.endAll()
    expect(streams.closing).toBe(true)
  })

  it('index.ts wires it: closeHttp goes through closeHttpServer, the SSE route registers its stream', () => {
    // index.ts cannot be loaded by a test (it boots the server); the wire is
    // pinned on its source, as `mutatingRouteCoverage.test.ts` does.
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/const outcome = await closeHttpServer\(server, \{\s*longLived: longLivedResponses, inFlight: inFlightHandlers, handlerDeadlineAt: signalAt \+ 20_000,\s*\}\)/)
    expect(source).toContain('flushLateWrites: () => repo.flush(),')
    expect(source).not.toMatch(/closeHttp: \(\) => new Promise<void>\(\(resolve\) => server\.close/)
    const route = source.slice(source.indexOf("app.get('/api/model/cache/events'"), source.indexOf("app.get('/api/model/cache/changes'"))
    expect(route).toContain('untrackStream = longLivedResponses.track(res, cleanup)')
    expect(route).toContain('untrackStream?.()')
    expect(route).toContain('longLivedResponses.closing')
    // The handler census is mounted FIRST and the `route()` wrapper holds
    // each handler's promise; the relayed SSE registers in the same set.
    const afterApp = source.slice(source.indexOf('const app = express()'))
    expect(afterApp.indexOf('app.use(')).toBe(afterApp.indexOf('app.use(inFlightHandlers.middleware())'))
    // route(): held, and refused after the seal.
    expect(source).toContain('routeHandler<express.Request, express.Response>(holdHandler(inFlightHandlers, handler))')
    expect(source).toMatch(/createWorkspaceHttpRouting\(\{[\s\S]*?longLived: longLivedResponses,[\s\S]*?\}\)\)/)
  })
})
