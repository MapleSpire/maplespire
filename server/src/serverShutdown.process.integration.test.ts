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
 * T-DIAGDEF (4) — ONE SIGTERM to the REAL server (`src/index.ts`, its own
 * process, a fresh database) while a "browser" holds what a page holds: the
 * Automerge WebSocket, the read-model SSE stream (`/api/model/cache/events`)
 * and an idle keep-alive connection. A manual test measured `outcome=forced-exit`
 * after 30 s every time (the `http` step never ended); without a browser the
 * same stop took ~110 ms.
 *
 * Out of process on purpose: `index.ts` cannot be loaded by a test, and what
 * is judged is the process actually leaving — its exit code, its time, and the
 * `server.shutdown_trace` it logs.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { Agent, request, type IncomingMessage } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

const CONNECTION = process.env.TEST_DATABASE_URL
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url))

async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

function get(port: number, path: string, agent: Agent): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent }, resolve)
    req.on('error', reject)
    req.end()
  })
}

describe.skipIf(!CONNECTION)('T-DIAGDEF (4) — SIGTERM with a browser connected (real server process)', () => {
  const database = `diagdef_shutdown_${process.pid}_${Date.now()}`
  let admin: pg.Client
  let child: ChildProcess | null = null

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: CONNECTION })
    await admin.connect()
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  })
  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL')
    await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined)
    await admin?.end()
  })

  it('exits by itself, complete, in a few seconds — not on the 30 s forced exit', async () => {
    const url = new URL(CONNECTION!)
    url.pathname = `/${database}`
    const port = await freePort()
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(port),
        BIND_ADDRESS: '127.0.0.1',
        DATABASE_URL: url.toString(),
        AUTH: 'off',
        READ_MODEL: 'on',
        NODE_ENV: 'development',
        REDIS_URL: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    child.stdout!.on('data', (chunk) => { out += String(chunk) })
    child.stderr!.on('data', (chunk) => { out += String(chunk) })
    const exited = once(child, 'exit') as Promise<[number | null, string | null]>

    // Ready (schema, Automerge, read model).
    const readyBy = Date.now() + 120_000
    for (;;) {
      const ok = await fetch(`http://127.0.0.1:${port}/api/ready`).then((r) => r.ok).catch(() => false)
      if (ok) break
      if (Date.now() > readyBy || child.exitCode !== null) throw new Error(`server never ready:\n${out.slice(-4000)}`)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    // What an open page holds.
    const agent = new Agent({ keepAlive: true, maxSockets: 8 })
    const idle = await get(port, '/api/ready', agent)
    idle.resume()
    await once(idle, 'end')
    const sse = await get(port, '/api/model/cache/events', agent)
    expect(sse.statusCode).toBe(200)
    expect(sse.headers['content-type']).toContain('text/event-stream')
    sse.resume()
    const ws = new WebSocket(`ws://127.0.0.1:${port}/automerge`)
    await once(ws, 'open')
    const wsClosed = once(ws, 'close')
    await new Promise((resolve) => setTimeout(resolve, 300))

    const signalledAt = performance.now()
    child.kill('SIGTERM')
    const [code] = await exited
    const exitMs = performance.now() - signalledAt
    agent.destroy()

    const traceLine = out.split('\n').find((line) => line.includes('"server.shutdown_trace"'))
    expect(traceLine, out.slice(-4000)).toBeDefined()
    const trace = JSON.parse(traceLine!) as { outcome: string; totalMs: number; steps: { step: string; endMs?: number }[] }
    console.log(JSON.stringify({ event: 'tdiagdef.shutdown_measure', exitMs: Math.round(exitMs), code, trace }))
    expect(trace.outcome).toBe('complete')
    expect(trace.steps.find((step) => step.step === 'http')?.endMs).toBeDefined()
    expect(code).toBe(0)
    expect(exitMs).toBeLessThan(5_000)
    const [wsCode] = await wsClosed
    expect(wsCode).toBe(1012)
  }, 180_000)
})
