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

import { createServer, type Server, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RedisRuntime, readinessSourceOf } from './redis.js'
import { collectReadiness, readinessReport, routerReadinessReport, type ReadinessInputs } from './readiness.js'

const here = dirname(fileURLToPath(import.meta.url))

const healthy: ReadinessInputs = {
  database: true,
  automerge: true,
  readModel: true,
  shuttingDown: false,
  redis: { configured: true, required: true, reachable: true },
  renderCacheRedis: { configured: true, reachable: true },
  ownership: { enabled: true, canServe: true, ready: true },
}

describe('readinessReport (pure)', () => {
  it('is ready when every dependency answers and the cell can serve', () => {
    const report = readinessReport(healthy)
    expect(report.status).toBe(200)
    expect(report.body).toEqual({
      status: 'ready',
      checks: { database: true, automerge: true, readModel: true, redis: true, renderCacheRedis: true, syncCellOwnership: true, syncCellConverged: true },
      shuttingDown: false,
    })
  })

  it('D48: a REQUIRED Redis that does not answer makes the cell not ready, and the body says which check', () => {
    const report = readinessReport({ ...healthy, redis: { configured: true, required: true, reachable: false } })
    expect(report.status).toBe(503)
    expect(report.body.status).toBe('not-ready')
    expect(report.body.checks.redis).toBe(false)
  })

  it('an unconfigured Redis is `null`, never `false` — absence is not an outage', () => {
    const report = readinessReport({
      ...healthy,
      redis: { configured: false, required: false, reachable: null },
      renderCacheRedis: { configured: false, reachable: null },
    })
    expect(report.status).toBe(200)
    expect(report.body.checks.redis).toBeNull()
    expect(report.body.checks.renderCacheRedis).toBeNull()
  })

  it('…and `configured: false` wins over whatever a probe result says — the report guards it itself, not only the collector', () => {
    // The arm above feeds `reachable: null` — the collector's own output — so
    // the guard has nothing to do there. A caller that hands a boolean for an
    // unconfigured runtime must still read `null`.
    for (const reachable of [false, true]) {
      const report = readinessReport({
        ...healthy,
        redis: { configured: false, required: false, reachable },
        renderCacheRedis: { configured: false, reachable },
      })
      expect(report.status).toBe(200)
      expect(report.body.checks.redis).toBeNull()
      expect(report.body.checks.renderCacheRedis).toBeNull()
    }
  })

  it('an OPTIONAL Redis that does not answer is reported false but does not gate readiness', () => {
    const report = readinessReport({ ...healthy, redis: { configured: true, required: false, reachable: false } })
    expect(report.status).toBe(200)
    expect(report.body.checks.redis).toBe(false)
  })

  it('the render cache is informational: unreachable, the cell is still ready', () => {
    const report = readinessReport({ ...healthy, renderCacheRedis: { configured: true, reachable: false } })
    expect(report.status).toBe(200)
    expect(report.body.checks.renderCacheRedis).toBe(false)
  })

  it('B0a-7: a standby that owns nothing but can forward is READY, and says it is not converged', () => {
    const report = readinessReport({ ...healthy, ownership: { enabled: true, canServe: true, ready: false } })
    expect(report.status).toBe(200)
    expect(report.body.checks.syncCellOwnership).toBe(true)
    expect(report.body.checks.syncCellConverged).toBe(false)
  })

  it('a cell that can neither serve nor forward, or is shutting down, or has no database, is not ready', () => {
    expect(readinessReport({ ...healthy, ownership: { enabled: true, canServe: false, ready: false } }).status).toBe(503)
    expect(readinessReport({ ...healthy, shuttingDown: true }).status).toBe(503)
    expect(readinessReport({ ...healthy, database: false }).status).toBe(503)
    expect(readinessReport({ ...healthy, automerge: false }).status).toBe(503)
    expect(readinessReport({ ...healthy, readModel: false }).status).toBe(503)
  })
})

describe('collectReadiness (the probes)', () => {
  it('runs the probes, never lets one throw past the door, and keeps `null` for what is not configured', async () => {
    const report = await collectReadiness({
      database: async () => true,
      redis: { configured: true, required: true, reachable: async () => { throw new Error('probe blew up') } },
      renderCacheRedis: { configured: false, reachable: async () => true },
      automerge: true,
      readModel: true,
      shuttingDown: false,
      ownership: null,
    })
    expect(report.status).toBe(503)
    expect(report.body.checks.redis).toBe(false)
    expect(report.body.checks.renderCacheRedis).toBeNull()
    expect(report.body.checks.syncCellOwnership).toBeNull()
  })

  it('a database probe that rejects is `false`, not a thrown 500', async () => {
    const report = await collectReadiness({
      database: async () => { throw new Error('connection refused') },
      redis: { configured: false, required: false, reachable: async () => true },
      renderCacheRedis: { configured: false, reachable: async () => true },
      automerge: true,
      readModel: true,
      shuttingDown: false,
      ownership: null,
    })
    expect(report.status).toBe(503)
    expect(report.body.checks.database).toBe(false)
    // The collector never PROBES an unconfigured Redis, and reports it as null.
    expect(report.body.checks.redis).toBeNull()
  })

  it('an unconfigured Redis is not probed at all — the collector does not call `reachable`', async () => {
    let probed = 0
    await collectReadiness({
      database: async () => true,
      redis: { configured: false, required: false, reachable: async () => { probed += 1; return true } },
      renderCacheRedis: { configured: false, reachable: async () => { probed += 1; return true } },
      automerge: true,
      readModel: true,
      shuttingDown: false,
      ownership: null,
    })
    expect(probed).toBe(0)
  })

  it('a probe that throws SYNCHRONOUSLY (not a rejected promise) is `false` too — `f().then(ok, fail)` would have let it out', async () => {
    // "Never lets one throw" must hold for synchronous throws, not just
    // rejections.
    const syncThrow = (() => { throw new Error('sync') }) as unknown as () => Promise<boolean>
    const report = await collectReadiness({
      database: syncThrow,
      redis: { configured: true, required: true, reachable: syncThrow },
      renderCacheRedis: { configured: true, reachable: syncThrow },
      automerge: true,
      readModel: true,
      shuttingDown: false,
      ownership: null,
    })
    expect(report.status).toBe(503)
    expect(report.body.checks).toMatchObject({ database: false, redis: false, renderCacheRedis: false })
  })

  it('the probes run in PARALLEL — the door takes the slowest, not the sum', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const after = (ms: number) => () => new Promise<boolean>((settle) => setTimeout(() => settle(true), ms))
      let report: Awaited<ReturnType<typeof collectReadiness>> | null = null
      void collectReadiness({
        database: after(100),
        redis: { configured: true, required: true, reachable: after(100) },
        renderCacheRedis: { configured: true, reachable: after(100) },
        automerge: true,
        readModel: true,
        shuttingDown: false,
        ownership: null,
      }).then((value) => { report = value })
      await vi.advanceTimersByTimeAsync(100)
      // A sequential collector would still be waiting for the second probe (200 ms in).
      expect(report).not.toBeNull()
      expect(report!.status).toBe(200)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('routerReadinessReport (pure) — the owner-aware router answers the probe, nothing else', () => {
  const inputs = { partitionCount: 2, configuredGeneration: 'gen-1', effectiveGeneration: 'gen-1.ce1461953e2b8ac2', topologyGeneration: 'gen-1.ce1461953e2b8ac2', topology: { state: 'pending' } }

  it('Redis reachable → 200 with the probe in the body and the topology published beside it', () => {
    const report = routerReadinessReport({ ...inputs, reachable: true })
    expect(report.status).toBe(200)
    expect(report.body).toEqual({ ready: true, checks: { redis: true }, role: 'owner-aware-ws-router', partitionCount: 2, configuredGeneration: 'gen-1', effectiveGeneration: 'gen-1.ce1461953e2b8ac2', topologyGeneration: 'gen-1.ce1461953e2b8ac2', topology: { state: 'pending' } })
  })

  it('D48: Redis unreachable → 503, whatever the topology says — a QA mutant that ignored the probe survived the source pin alone', () => {
    const report = routerReadinessReport({ ...inputs, reachable: false, topology: { state: 'confirmed' } })
    expect(report.status).toBe(503)
    expect(report.body.ready).toBe(false)
    expect(report.body.checks.redis).toBe(false)
    expect(report.body.topology).toEqual({ state: 'confirmed' })
  })
})

/**
 * Against the real client. The paused-container shape is a peer that ANSWERED
 * — the connection is `ready` — and then goes silent while the kernel keeps the
 * TCP session alive (the handshake completes, PING goes unanswered). A
 * `net.Server` speaking just enough RESP reproduces it: `+OK` to the
 * `CLIENT SETINFO` commands node-redis sends on connect, `+PONG` to PING, then
 * a `silent` switch that stops every reply while the socket stays open. (A peer
 * silent from the FIRST byte is a different shape — the handshake never
 * completes and the client is simply not ready.) The precondition
 * `runtime.ready === true` is asserted, because if it ever stopped holding this
 * arm would pass for the wrong reason. With `reachable` reading the flag
 * instead of probing, the report would be 200 with `checks.redis: true`.
 */
describe('a cell whose Redis went silent after connecting (the paused-container shape)', () => {
  let server: Server | null = null
  let runtime: RedisRuntime | null = null
  const sockets = new Set<Socket>()
  let silent = false

  afterEach(async () => {
    // No race and no early socket destroy here, on purpose: `stop()` is
    // BOUNDED by the runtime itself, and a teardown that papered over a hang
    // would hide the arm below going red. Let the peer answer again first so a
    // healthy stop is the common path.
    silent = false
    await runtime?.stop().catch(() => undefined)
    runtime = null
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await new Promise<void>((resolveClose) => { if (server) server.close(() => resolveClose()); else resolveClose() })
    server = null
  })

  /**
   * A peer that speaks the RESP the client needs and can be told to shut up.
   * Like a PAUSED process (not a dropping one), it keeps what arrived while it
   * was silent and answers all of it when it speaks again — the kernel buffered
   * those bytes for the real Redis too, and an `unpause` replies to every
   * queued command in order. Dropping them instead would misalign node-redis's
   * reply pipeline by one for ever, which is a fixture defect, not a finding.
   */
  async function listen(): Promise<number> {
    server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      const backlog: string[] = []
      const answer = (text: string) => {
        for (const command of text.split('*').filter(Boolean)) {
          socket.write(/\$4\r\nPING\r\n/i.test(command) ? '+PONG\r\n' : '+OK\r\n')
        }
      }
      socket.on('data', (data) => {
        if (silent) { backlog.push(data.toString()); return }
        while (backlog.length) answer(backlog.shift()!)
        answer(data.toString())
      })
    })
    await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', () => resolveListen()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    return address.port
  }

  const runtimeFor = (port: number, commandTimeoutMs: number, overrides: { required?: boolean; url?: string | null } = {}) => new RedisRuntime({
    url: overrides.url === undefined ? `redis://127.0.0.1:${port}` : overrides.url,
    host: null,
    port,
    tls: false,
    username: undefined,
    password: undefined,
    required: overrides.required ?? true,
    keyPrefix: 'readiness-test',
    connectWaitMs: 1_000,
    commandTimeoutMs,
  }, 'readiness-test')

  const deps = (source: RedisRuntime) => ({
    database: async () => true,
    redis: readinessSourceOf(source),
    renderCacheRedis: { configured: false, reachable: async () => true },
    automerge: true,
    readModel: true,
    shuttingDown: false,
    ownership: null,
  })

  it('answers 503 with checks.redis false within the command timeout — while the flag still says true', async () => {
    const port = await listen()
    runtime = runtimeFor(port, 150)
    await runtime.start()
    expect(runtime.ready).toBe(true)
    // Healthy first, so the 503 below is the SILENCE, not a broken fixture.
    expect((await collectReadiness(deps(runtime))).status).toBe(200)

    silent = true
    const startedAt = Date.now()
    const report = await collectReadiness(deps(runtime))
    const elapsedMs = Date.now() - startedAt

    expect(report.status).toBe(503)
    expect(report.body.checks.redis).toBe(false)
    // Bounded by the command timeout, with slack for the event loop: a door
    // that waits longer than that is a hung healthcheck, not a slow one.
    expect(elapsedMs).toBeLessThan(150 + 600)
    // THE TRAP, asserted: the flag never noticed — and the probe is an OBSERVER,
    // it did not tear the shared connection down either.
    expect(runtime.ready).toBe(true)
  })

  it('answers 200 with checks.redis true when the peer says PONG', async () => {
    const port = await listen()
    runtime = runtimeFor(port, 500)
    await runtime.start()
    expect(runtime.ready).toBe(true)

    const report = await collectReadiness(deps(runtime))
    expect(report.status).toBe(200)
    expect(report.body.checks.redis).toBe(true)
  })

  it('comes back to 200 when the peer answers again — no restart, no recycle', async () => {
    const port = await listen()
    runtime = runtimeFor(port, 150)
    await runtime.start()
    silent = true
    expect((await collectReadiness(deps(runtime))).status).toBe(503)
    silent = false
    expect((await collectReadiness(deps(runtime))).status).toBe(200)
  })

  it('a runtime that never connected is false at once, without waiting for the timeout', async () => {
    runtime = runtimeFor(1, 5_000) // nothing listens on port 1; never started
    const startedAt = Date.now()
    const report = await collectReadiness(deps(runtime))
    expect(report.status).toBe(503)
    expect(report.body.checks.redis).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  it('an OPTIONAL Redis (REDIS_REQUIRED off, the default) that went silent is reported false but the cell stays ready — through the real source, not a hand-fed flag', async () => {
    // Through the real source so that `required: true` hardcoded in
    // readinessSourceOf or in the collector fails here (the pure arm feeds the
    // flag itself). That mistake would mean 503 on every stack without a
    // required Redis.
    const port = await listen()
    runtime = runtimeFor(port, 150, { required: false })
    await runtime.start()
    silent = true
    const report = await collectReadiness(deps(runtime))
    expect(report.status).toBe(200)
    expect(report.body.checks.redis).toBe(false)
  })

  it('an UNCONFIGURED runtime through readinessSourceOf is `null`, ready, and never probed', async () => {
    // `required: false` with it: `runtimeConfig` refuses REDIS_REQUIRED=on
    // without a URL, so "unconfigured AND required" cannot exist in production.
    runtime = runtimeFor(0, 150, { url: null, required: false })
    const probe = vi.spyOn(runtime, 'probe')
    const report = await collectReadiness(deps(runtime))
    expect(report.status).toBe(200)
    expect(report.body.checks.redis).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('stop() is BOUNDED while a probe left a PING pending on a silent peer — the shutdown the lenses found hanging for the whole outage', async () => {
    // node-redis `close()` resolves only once the reply queue drains and
    // re-checks on 'data' alone; the probe never recycles its silent PING; so
    // an unbounded stop() during a Redis pause would run to the cell's 30 s
    // forced exit (and Docker's SIGKILL on the router).
    const port = await listen()
    runtime = runtimeFor(port, 150)
    await runtime.start()
    silent = true
    expect(await runtime.probe()).toBe(false) // one PING now pending for ever
    const stopped = runtime
    const startedAt = Date.now()
    await stopped.stop() // the peer is STILL silent: nothing will drain the queue
    const elapsedMs = Date.now() - startedAt
    expect(elapsedMs).toBeLessThan(150 + 600)
    // `destroy()` tears the socket down; node-redis flips `isReady` on the
    // socket's close event, one turn later — wait for the fact, not the tick.
    await vi.waitFor(() => expect(stopped.ready).toBe(false))
    runtime = null // stopped here; afterEach has nothing to stop
  })
})

/**
 * WIRING, pinned on source because neither entry point can be loaded by a test
 * (both listen at import). A door that computed readiness some other way would
 * leave every arm above green while lying.
 */
describe('the two readiness doors use this module and the probe', () => {
  // Comments are stripped before pinning, so a pin can neither be satisfied by
  // prose nor go red because prose named the flag.
  const stripComments = (source: string) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n')
  const indexSource = stripComments(readFileSync(resolve(here, '../index.ts'), 'utf8').replace(/\r\n/g, '\n'))
  const routerSource = stripComments(readFileSync(resolve(here, '../syncCells/routerMain.ts'), 'utf8').replace(/\r\n/g, '\n'))
  const redisSource = stripComments(readFileSync(resolve(here, './redis.ts'), 'utf8').replace(/\r\n/g, '\n'))

  it('index.ts answers /api/ready from collectReadiness with EVERY gate wired — both Redis runtimes probed, the database asked, ownership and shutdown carried', () => {
    const handler = indexSource.match(/app\.get\('\/api\/ready',[\s\S]*?\n\}\)\n/)?.[0] ?? ''
    expect(handler).toMatch(/const report = await collectReadiness\(\{/)
    expect(handler).toMatch(/database: \(\) => pool\.query\('SELECT 1'\)/)
    expect(handler).toMatch(/redis: readinessSourceOf\(redisRuntime\)/)
    expect(handler).toMatch(/renderCacheRedis: readinessSourceOf\(redisRenderCacheRuntime\)/)
    expect(handler).toMatch(/automerge: readiness\.automerge/)
    expect(handler).toMatch(/readModel: readiness\.readModel/)
    expect(handler).toMatch(/shuttingDown: readiness\.shuttingDown/)
    expect(handler).toMatch(/ownership: syncCellOwnership\?\.readSnapshot\(\) \?\? null/)
    expect(handler).toMatch(/res\.status\(report\.status\)\.json\(report\.body\)/)
    expect(handler).not.toMatch(/\.ready\b/)
  })

  it('routerMain.ts answers its /api/ready from the probe through routerReadinessReport, and writes THAT status', () => {
    const handler = routerSource.match(/request\.url === '\/api\/ready'[\s\S]*?\n\s+return\n/)?.[0] ?? ''
    expect(handler).toMatch(/redisRuntime\.probe\(\)\s*\.then\(\(reachable\) => routerReadinessReport\(\{/)
    expect(handler).toMatch(/reachable,/)
    expect(handler).toMatch(/response\.writeHead\(report\.status,/)
    expect(handler).toMatch(/response\.end\(JSON\.stringify\(report\.body\)\)/)
    expect(handler).toMatch(/\.catch\(/)
    expect(handler).not.toMatch(/redisRuntime\.ready\b/)
  })

  it('readinessSourceOf asks (probe), it does not read (ready), and passes `required` through', () => {
    const source = redisSource.match(/export function readinessSourceOf[\s\S]*?\n\}\n/)?.[0] ?? ''
    expect(source).toMatch(/reachable: \(\) => runtime\.probe\(\)/)
    expect(source).toMatch(/required: runtime\.required/)
    expect(source).not.toMatch(/runtime\.ready/)
  })
})
