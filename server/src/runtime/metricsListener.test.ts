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

import { spawn } from 'node:child_process'
import { Agent, request } from 'node:http'
import { createServer, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMetricsServer, startMetricsListener, type MetricsListener } from './metricsListener.js'
import type { MetricSample } from './metrics.js'

/**
 * Driven over a REAL socket rather than against the handler function.
 *
 * The handler is the easy half. What this file exists to pin is the wire: that
 * the listener binds, that a bind failure is survivable, and above all that
 * `stop()` releases an accepted keep-alive connection — otherwise a pooled
 * scraper connection keeps the process alive well past its expected exit.
 */

const TOKEN = 'a-token-that-is-not-a-secret-in-a-test'

const SAMPLE: MetricSample[] = [{
  name: 'maplespire_test_gauge',
  help: 'a gauge',
  type: 'gauge',
  values: [{ labels: { phase: 'sleeping' }, value: 42 }],
}]

const started: MetricsListener[] = []

afterEach(async () => {
  await Promise.all(started.splice(0).map((listener) => listener.stop()))
})

async function listen(overrides: {
  token?: string | undefined
  collect?: () => MetricSample[]
  log?: (event: string, fields?: Record<string, unknown>) => void
  port?: number
} = {}): Promise<MetricsListener> {
  const listener = await startMetricsListener({
    port: overrides.port ?? 0,
    host: '127.0.0.1',
    token: 'token' in overrides ? overrides.token : TOKEN,
    collect: overrides.collect ?? (() => SAMPLE),
    log: overrides.log ?? (() => {}),
  })
  expect(listener).not.toBeNull()
  started.push(listener as MetricsListener)
  return listener as MetricsListener
}

function fetchMetrics(port: number, init: {
  path?: string
  method?: string
  authorization?: string
} = {}): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: init.path ?? '/metrics',
      method: init.method ?? 'GET',
      headers: init.authorization ? { authorization: init.authorization } : {},
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('the drill scheduler metrics endpoint', () => {
  it('serves the exposition to a scraper carrying the token', async () => {
    const { port } = await listen()
    const res = await fetchMetrics(port, { authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/plain/)
    expect(res.body).toContain('maplespire_test_gauge{phase="sleeping"} 42\n')
    expect(res.body).toContain('# TYPE maplespire_test_gauge gauge')
  })

  it('collects on EVERY scrape rather than caching a first answer', async () => {
    // A cached body is a gauge that stops moving, which for a phase age is the
    // same as not having it: the whole signal is that the number climbs.
    let age = 1
    const { port } = await listen({
      collect: () => [{ ...SAMPLE[0], values: [{ value: age }] } as MetricSample],
    })
    const first = await fetchMetrics(port, { authorization: `Bearer ${TOKEN}` })
    age = 2
    const second = await fetchMetrics(port, { authorization: `Bearer ${TOKEN}` })
    expect(first.body).toContain('maplespire_test_gauge 1\n')
    expect(second.body).toContain('maplespire_test_gauge 2\n')
  })

  it('refuses a wrong token, a missing header and a non-Bearer scheme', async () => {
    const { port } = await listen()
    for (const authorization of [undefined, 'Bearer wrong', 'Basic ' + TOKEN, TOKEN]) {
      const res = await fetchMetrics(port, { authorization })
      expect(res.status).toBe(401)
      expect(res.headers['www-authenticate']).toBe('Bearer')
      expect(res.body).not.toContain('maplespire_test_gauge')
    }
  })

  it('does not exist at all when no token is configured', async () => {
    // 404 and not an open endpoint, matching `index.ts`. Failing open here
    // would publish the deployment's cadence and deadline to anything that can
    // reach the compose network.
    const { port } = await listen({ token: undefined })
    const res = await fetchMetrics(port, { authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(404)
    expect(res.body).not.toContain('maplespire_test_gauge')
  })

  it('serves nothing but /metrics, INCLUDING targets that break a URL parser', async () => {
    // `//`, `/\` and `///` make `new URL(req.url, 'http://localhost')` throw
    // `TypeError: Invalid URL`, and llhttp delivers every one of them to the
    // listener verbatim. A handler that parsed them outside its catch, ahead
    // of the token gate, would let an unauthenticated `GET //` kill the
    // container that makes the backups. Paths that parse cleanly alone could
    // not catch that.
    const { port } = await listen()
    for (const path of ['/', '/health', '/metrics/', '/api/ready', '//', '/\\', '///', '//evil']) {
      const res = await fetchMetrics(port, { path, authorization: `Bearer ${TOKEN}` })
      expect(res.status, `path ${path}`).toBe(404)
    }
  })

  it('survives a parser-breaking target with NO token, which is how it was reachable', async () => {
    // Asserted separately because nothing on the compose network needs a
    // credential to reach the first line of the handler.
    const { port } = await listen({ token: undefined })
    for (const path of ['//', '/\\']) {
      const res = await fetchMetrics(port, { path })
      expect(res.status, `path ${path}`).toBe(404)
    }
    // ...and the listener is still alive afterwards.
    const alive = await fetchMetrics(port, { path: '/metrics' })
    expect(alive.status).toBe(404)
  })

  it('ignores a query string on the metrics path', async () => {
    // Prometheus does not add one, but a human curling with `?debug` should get
    // the metrics rather than a confusing 404.
    const { port } = await listen()
    const res = await fetchMetrics(port, { path: '/metrics?x=1', authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(200)
  })

  it('rejects a write, but only AFTER the token', async () => {
    // The order matters: a 405 ahead of the token gate would tell an
    // unauthenticated caller that the path exists, which contradicts the "the endpoint does not
    // exist without a token" posture the 404 branch is written for.
    const { port } = await listen()
    const res = await fetchMetrics(port, { method: 'POST', authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe('GET, HEAD')

    // No token configured: 404, never 405.
    const anonymous = await listen({ token: undefined })
    const hidden = await fetchMetrics(anonymous.port, { method: 'POST' })
    expect(hidden.status).toBe(404)

    // Token configured but not presented: 401, never 405.
    const unauthorized = await fetchMetrics(port, { method: 'POST' })
    expect(unauthorized.status).toBe(401)
  })

  it('answers HEAD with headers and no body', async () => {
    const { port } = await listen()
    const res = await fetchMetrics(port, { method: 'HEAD', authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(200)
    expect(res.body).toBe('')
  })

  it('SURVIVES a collector that throws, and says so', async () => {
    // The load-bearing one. An uncaught throw inside a `node:http` handler is
    // an uncaught exception, and `drillScheduler` is a standalone entrypoint
    // with no handler for it — so without this the container that runs the
    // backups dies on a scrape, under `restart: always`, forever. A scrape may
    // fail; a drill may not.
    const log = vi.fn()
    let broken = true
    const { port } = await listen({
      log,
      collect: () => {
        if (broken) throw new Error('pg_stat_activity is on fire')
        return SAMPLE
      },
    })
    const failed = await fetchMetrics(port, { authorization: `Bearer ${TOKEN}` })
    expect(failed.status).toBe(500)
    expect(log).toHaveBeenCalledWith('metrics_request_failed', expect.objectContaining({
      error: 'pg_stat_activity is on fire',
    }))

    // ...and the listener is still there afterwards, which is the half that
    // distinguishes "handled" from "crashed and got restarted by the harness".
    broken = false
    const recovered = await fetchMetrics(port, { authorization: `Bearer ${TOKEN}` })
    expect(recovered.status).toBe(200)
    expect(recovered.body).toContain('maplespire_test_gauge')
  })
})

describe('binding and stopping', () => {
  it('returns null and logs when the port is taken, instead of throwing', async () => {
    // A bind failure must not be fatal here. `listenReady`'s own docblock says
    // the caller is expected to let the rejection terminate the process — right
    // for the sync server, and exactly wrong for the container whose job is to
    // produce the backups.
    const squatter = createServer()
    await new Promise<void>((settle) => squatter.listen(0, '127.0.0.1', settle))
    const taken = (squatter.address() as { port: number }).port
    const log = vi.fn()
    try {
      const listener = await startMetricsListener({
        port: taken,
        host: '127.0.0.1',
        token: TOKEN,
        collect: () => SAMPLE,
        log,
      })
      expect(listener).toBeNull()
      expect(log).toHaveBeenCalledWith(
        'metrics_listener_failed',
        expect.objectContaining({ port: taken }),
      )
    } finally {
      await new Promise<void>((settle) => squatter.close(() => settle()))
    }
  })

  it('reports the port the OS actually gave it', async () => {
    // Not the port that was ASKED for: the tests bind 0, and so would anyone
    // debugging a collision. A listener that echoes its input cannot be used to
    // find out where it landed.
    const listener = await listen({ port: 0 })
    expect(listener.port).toBeGreaterThan(0)
    const res = await fetchMetrics(listener.port, { authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(200)
  })

  it('DESTROYS a pooled keep-alive socket on stop', async () => {
    // Prometheus keeps its connection open between scrapes, and
    // `server.unref()` does not reach an accepted socket, so without this a
    // stopping process could hang until its container's grace period ends in
    // SIGKILL.
    //
    // The in-process observable is the socket: after `stop()` the pooled
    // connection is destroyed rather than left idle.
    const listener = await listen()
    const agent = new Agent({ keepAlive: true })
    try {
      await new Promise<void>((settle, fail) => {
        const req = request({
          host: '127.0.0.1',
          port: listener.port,
          path: '/metrics',
          agent,
          headers: { authorization: `Bearer ${TOKEN}` },
        }, (res) => { res.resume(); res.on('end', () => settle()) })
        req.on('error', fail)
        req.end()
      })
      const sockets = Object.values(agent.freeSockets).flat()
      expect(sockets.length).toBeGreaterThan(0)
      expect(sockets.every((socket) => socket?.destroyed)).toBe(false)

      await listener.stop()

      // Give the FIN a turn of the loop to land on the client side.
      await new Promise((settle) => { setTimeout(settle, 50) })
      expect(sockets.every((socket) => socket?.destroyed)).toBe(true)
    } finally {
      agent.destroy()
    }
  })

  it('can never hold the process open, on ANY exit path', async () => {
    // The guarantee a `try/finally` around the caller's body would NOT give,
    // because a finally covers the paths somebody enumerated. E.g. `mkdir` on
    // the bundle root throws, the scheduler's top-level catch sets
    // `exitCode = 1` and expects the loop to drain, and an open listener turns
    // that into a container that never exits and therefore never restarts.
    //
    // In-process the observable is the ref flag of the SERVER-side accepted
    // socket, which is the one `unref()` is applied to — `agent.freeSockets`
    // holds the client's, a different set entirely, and asserting on those
    // would pass whatever the server does. The out-of-process test below
    // proves the exit itself.
    const server = createMetricsServer({ token: TOKEN, collect: () => SAMPLE, log: () => {} })
    const accepted: Socket[] = []
    // Registered AFTER the module's own handler, so `unref()` has already run
    // by the time this fires.
    server.on('connection', (socket) => accepted.push(socket))
    await new Promise<void>((settle) => server.listen(0, '127.0.0.1', settle))
    const port = (server.address() as { port: number }).port

    const agent = new Agent({ keepAlive: true })
    try {
      await new Promise<void>((settle, fail) => {
        const req = request({
          host: '127.0.0.1', port, path: '/metrics', agent,
          headers: { authorization: `Bearer ${TOKEN}` },
        }, (res) => { res.resume(); res.on('end', () => settle()) })
        req.on('error', fail)
        req.end()
      })
      expect(accepted).toHaveLength(1)
      // `net.Socket` exposes `ref()`/`unref()` but no `hasRef()`; the ref state
      // lives on the internal handle. Asserted in two steps ON PURPOSE — if a
      // Node upgrade removes `_handle.hasRef`, the first assertion fails
      // loudly instead of the second silently reading `undefined` and this
      // test becoming a check that runs and cannot disagree.
      const handle = (accepted[0] as unknown as { _handle?: { hasRef?: () => boolean } })._handle
      expect(typeof handle?.hasRef).toBe('function')
      expect(handle?.hasRef?.()).toBe(false)
      expect(accepted[0]?.destroyed).toBe(false)
    } finally {
      agent.destroy()
      await new Promise<void>((settle) => { server.close(() => settle()); server.closeAllConnections() })
    }
  })

  it('binds where a SIBLING container can reach it', async () => {
    // 127.0.0.1 would bind this container's own loopback, and Prometheus is a
    // sibling — the exact mistake compose.maplespire.yml documents for
    // prometheus's own listener, which left every Grafana panel without a data
    // source.
    //
    // Connecting to 127.0.0.1 and asserting a 200 succeeds against either
    // bind, so the bind address itself is what is asserted. Every other test
    // here passes `host` explicitly and none of them can see the default.
    const listener = await startMetricsListener({
      port: 0,
      token: TOKEN,
      collect: () => SAMPLE,
      log: () => {},
    })
    expect(listener).not.toBeNull()
    started.push(listener as MetricsListener)
    expect((listener as MetricsListener).address).toBe('0.0.0.0')

    const res = await fetchMetrics((listener as MetricsListener).port, {
      authorization: `Bearer ${TOKEN}`,
    })
    expect(res.status).toBe(200)
  })

  it('reports the address it was asked for when one is given', async () => {
    const listener = await listen()
    expect(listener.address).toBe('127.0.0.1')
  })

  it('lets a process with nothing else to do EXIT — proven out of process', async () => {
    // The in-process test above sees one accepted socket's ref flag. It cannot
    // see the property that matters, because a test runner's event loop never
    // drains: does a process holding only this listener actually exit?
    //
    // `qa/metricsListenerExit.mts` answers it, and ships its own CONTROL — the
    // same shape with no unref anywhere, which MUST hang. Without that arm a
    // green run would only say the probe reached its report, never that it
    // could tell the two outcomes apart.
    const probe = fileURLToPath(new URL('../../qa/metricsListenerExit.mts', import.meta.url))
    // `node --import tsx`, never `npx` through a shell: `shell: true` splits a
    // checkout path containing a space, and the resulting missing-file failure
    // would read as a pass without the control arm. It is also faster.
    const arm = (which: string) => new Promise<{ code: number | null; out: string }>((settle) => {
      const child = spawn(process.execPath, ['--import', 'tsx', probe, which], { windowsHide: true })
      let out = ''
      child.stdout.on('data', (chunk) => { out += String(chunk) })
      child.stderr.on('data', (chunk) => { out += String(chunk) })
      child.on('close', (code) => settle({ code, out }))
    })

    const [listener, control] = await Promise.all([arm('listener'), arm('control')])
    expect(control.out).toContain('STILL_ALIVE')
    expect(control.code).toBe(7)
    expect(listener.out).not.toContain('STILL_ALIVE')
    expect(listener.code).toBe(0)
  }, 60_000)

  it('stops idempotently and refuses connections afterwards', async () => {
    const listener = await listen()
    // PROMISE IDENTITY, which is the only thing the `if (stopped) return stopped`
    // memo actually buys: a second `server.close()` hands
    // `ERR_SERVER_NOT_RUNNING` to the callback, `done` ignores it, and the
    // promise settles either way — so "it resolved twice" is not evidence of
    // idempotence.
    const first = listener.stop()
    expect(listener.stop()).toBe(first)
    await first
    expect(listener.stop()).toBe(first)

    await expect(fetchMetrics(listener.port, { authorization: `Bearer ${TOKEN}` }))
      .rejects.toThrow()
  })

  /*
   * NOT COVERED: removing `closeAllConnections()` leaves every test in this
   * file green, because since Node 19 `close()` alone destroys an IDLE
   * keep-alive socket. The two differ only for a scrape still IN FLIGHT when
   * `stop()` is called, which cannot be staged reliably because `collect` is
   * synchronous by design. The cost is bounded: `stop()` carries a 2 s ceiling.
   */

})
