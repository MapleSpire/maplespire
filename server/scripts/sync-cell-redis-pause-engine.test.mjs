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

import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { test } from 'node:test'
import { createLocalDockerPauseTransport, localDockerEngineEndpoint } from './sync-cell-redis-pause-engine.mjs'
import { runStandaloneObservation } from './sync-cell-redis-pause-observe.mjs'

const id = 'a'.repeat(64)
const containerName = 'unit-redis-1'
const transportOptions = { engineHost: 'unix:///task-local-fake-engine.sock', containerName, containerId: id }
const inspection = { Id: id, State: { Paused: false }, Config: { Env: ['DO_NOT_PUBLISH=unit-test-secret'] } }
const sendJson = (response, body) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)) }

async function fakeEngine(t, handler) {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method, path: req.url })
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  return {
    requests,
    // Only the connection changes in this seam. Method, path, framing,
    // response parsing, deadline and errors all use a real HTTP exchange.
    request: (options, callback) => request({ ...options, socketPath: undefined, hostname: '127.0.0.1', port: server.address().port }, callback),
  }
}

test('Engine transport accepts explicit local sockets and rejects remote or ambiguous endpoints', () => {
  assert.equal(localDockerEngineEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine').socketPath, '\\\\.\\pipe\\dockerDesktopLinuxEngine')
  assert.equal(localDockerEngineEndpoint('unix:///var/run/docker.sock').socketPath, '/var/run/docker.sock')
  for (const host of [null, '', 'http://127.0.0.1:2375', 'tcp://localhost:2375', 'ssh://host', 'npipe:////remote/pipe/docker_engine', 'npipe:////./pipe/a/b', 'unix:////remote/socket', 'unix:///socket?q=1']) {
    assert.throws(() => localDockerEngineEndpoint(host), /explicit local/)
  }
})

test('real HTTP preflight compares identity, then only pause/unpause target that exact Id; evidence omits Config.Env', async (t) => {
  const fake = await fakeEngine(t, (req, res) => {
    if (req.method === 'GET') sendJson(res, inspection)
    else { res.writeHead(204); res.end() }
  })
  const transport = await createLocalDockerPauseTransport(transportOptions, fake)
  assert.deepEqual(fake.requests, [{ method: 'GET', path: '/v1.40/containers/unit-redis-1/json' }], 'preflight performs no mutation')
  assert.equal(transport.evidence.cliContainerId, id)
  assert.equal(transport.evidence.engineContainerId, id)
  assert.equal(transport.evidence.kind, 'docker-engine')
  assert.doesNotMatch(JSON.stringify(transport.evidence), /DO_NOT_PUBLISH|unit-test-secret|Config|Env/)
  await assert.rejects(transport.change('stop'), /only pause and unpause/)
  await transport.change('pause')
  await transport.change('unpause')
  assert.deepEqual(fake.requests.slice(1), [
    { method: 'POST', path: `/v1.40/containers/${id}/pause` },
    { method: 'POST', path: `/v1.40/containers/${id}/unpause` },
  ])
})

test('wrong identity or foreign pause refuses the transport before any mutation', async (t) => {
  for (const body of [{ ...inspection, Id: 'b'.repeat(64) }, { ...inspection, State: { Paused: true } }, { ...inspection, State: {} }]) {
    const fake = await fakeEngine(t, (_req, res) => sendJson(res, body))
    await assert.rejects(createLocalDockerPauseTransport(transportOptions, fake), /identity|already paused/)
    assert.equal(fake.requests.length, 1)
    assert.equal(fake.requests[0].method, 'GET')
  }
})

const witnessInspection = () => ({
  Id: id, Name: `/${containerName}`, Image: `sha256:${'e'.repeat(64)}`, RestartCount: 0,
  State: { Running: true, Paused: false, StartedAt: '2026-09-06T00:00:00.000000000Z' },
  Config: { Env: ['DO_NOT_PUBLISH=unit-test-secret'], Labels: {
    'com.docker.compose.project': 'unit', 'com.docker.compose.service': 'redis',
  } },
  NetworkSettings: { Networks: { 'unit-network': { NetworkID: 'd'.repeat(64), IPAddress: '172.29.0.4' } } },
})
const witnessOptions = { ...transportOptions, witnessNetwork: 'unit-network', project: 'unit' }

test('witness target is the critical Redis bridge IP and final verification uses its pinned Id, with no secret fields', async t => {
  const fake = await fakeEngine(t, (_req, res) => sendJson(res, witnessInspection()))
  const transport = await createLocalDockerPauseTransport(witnessOptions, fake)
  assert.equal(transport.witnessTarget.ip, '172.29.0.4')
  assert.equal(transport.witnessTarget.port, 6379)
  assert.equal(transport.witnessTarget.networkId, 'd'.repeat(64))
  assert.equal(transport.witnessTarget.service, 'redis')
  assert.equal(Object.isFrozen(transport.witnessTarget), true)
  const verified = await transport.verifyWitnessIdentity()
  assert.deepEqual(verified.initial, verified.final)
  assert.equal(verified.valid, true)
  assert.doesNotMatch(JSON.stringify({ target: transport.witnessTarget, verified }), /DO_NOT_PUBLISH|unit-test-secret|Config|Env/)
  assert.deepEqual(fake.requests.map(item => item.path), [
    `/v1.40/containers/${containerName}/json`, `/v1.40/containers/${id}/json`,
  ])
  assert.ok(fake.requests.every(item => item.method === 'GET'))
})

test('witness target refuses wrong service, project, running state, network or address before an injection', async t => {
  const mutations = [
    body => { body.Config.Labels['com.docker.compose.service'] = 'render-cache' },
    body => { body.Config.Labels['com.docker.compose.project'] = 'foreign' },
    body => { body.Name = '/foreign-redis-1' },
    body => { body.State.Running = false },
    body => { body.State.StartedAt = 'invalid' },
    body => { body.RestartCount = null },
    body => { body.Image = 'redis:alpine' },
    body => { body.NetworkSettings.Networks = {} },
    body => { body.NetworkSettings.Networks['unit-network'].NetworkID = 'short' },
    body => { body.NetworkSettings.Networks['unit-network'].IPAddress = 'redis.example.test' },
    body => { body.NetworkSettings.Networks['unit-network'].IPAddress = '0.0.0.0' },
  ]
  for (const mutate of mutations) {
    const body = witnessInspection(); mutate(body)
    const fake = await fakeEngine(t, (_req, res) => sendJson(res, body))
    await assert.rejects(createLocalDockerPauseTransport(witnessOptions, fake), /witness identity/)
    assert.equal(fake.requests.length, 1)
    assert.equal(fake.requests[0].method, 'GET')
  }
})

test('final witness verification refuses restart or bridge reassignment even on the same container Id', async t => {
  for (const mutate of [
    body => { body.State.StartedAt = '2026-09-06T01:00:00.000000000Z' },
    body => { body.RestartCount = 1 },
    body => { body.Image = `sha256:${'f'.repeat(64)}` },
    body => { body.NetworkSettings.Networks['unit-network'].IPAddress = '172.29.0.5' },
    body => { body.NetworkSettings.Networks['unit-network'].NetworkID = 'f'.repeat(64) },
  ]) {
    let reads = 0
    const fake = await fakeEngine(t, (_req, res) => {
      const body = witnessInspection()
      if (++reads > 1) mutate(body)
      sendJson(res, body)
    })
    const transport = await createLocalDockerPauseTransport(witnessOptions, fake)
    await assert.rejects(transport.verifyWitnessIdentity(), /identity changed/)
    assert.equal(fake.requests.length, 2)
  }
})

test('clock reads use bounded read-only Engine info and retain only the clock and version', async (t) => {
  const info = { SystemTime: '2026-09-06T21:00:00.123456789Z', ServerVersion: '29.7.2', RegistryConfig: 'private-info' }
  const fake = await fakeEngine(t, (req, res) => sendJson(res, req.url.endsWith('/info') ? info : inspection))
  const transport = await createLocalDockerPauseTransport(transportOptions, fake)
  assert.deepEqual(await transport.readClock(), { generatedAt: info.SystemTime, version: '29.7.2' })
  assert.deepEqual(fake.requests.at(-1), { method: 'GET', path: '/v1.40/info' })
  assert.equal(fake.requests.every(req => req.method === 'GET'), true)
})

test('missing or malformed Engine clock rejects without publishing the response body', async (t) => {
  for (const body of [{ SystemTime: null }, { SystemTime: 'private-invalid-time' }, 'private-invalid-json']) {
    const fake = await fakeEngine(t, (req, res) => {
      if (!req.url.endsWith('/info')) return sendJson(res, inspection)
      if (typeof body === 'string') { res.writeHead(200); res.end(body) }
      else sendJson(res, body)
    })
    const transport = await createLocalDockerPauseTransport(transportOptions, fake)
    await assert.rejects(transport.readClock(), error => {
      assert.match(error.message, /valid JSON|valid SystemTime/)
      assert.doesNotMatch(error.message, /private-/)
      return true
    })
  }
})

test('bad JSON and failed HTTP responses never copy the inspection body into errors', async (t) => {
  for (const status of [200, 500]) {
    const fake = await fakeEngine(t, (_req, res) => { res.writeHead(status); res.end('unit-test-secret invalid JSON') })
    await assert.rejects(createLocalDockerPauseTransport(transportOptions, fake), (error) => {
      assert.doesNotMatch(error.message, /unit-test-secret/)
      assert.match(error.message, /valid JSON|HTTP 500/)
      return true
    })
  }
})

test('a successful-looking 200 response is not the required Engine mutation acknowledgement', async (t) => {
  const fake = await fakeEngine(t, (req, res) => {
    if (req.method === 'GET') sendJson(res, inspection)
    else { res.writeHead(200); res.end('OK') }
  })
  const transport = await createLocalDockerPauseTransport(transportOptions, fake)
  await assert.rejects(transport.change('pause'), /HTTP 200, expected 204/)
})

test('absolute request deadline includes delayed headers and a body that keeps sending bytes', async (t) => {
  for (const mode of ['headers', 'body']) {
    let responseClosed = false
    const fake = await fakeEngine(t, (_req, res) => {
      if (mode === 'body') { res.writeHead(200); res.flushHeaders() }
      const timer = setInterval(() => { if (mode === 'body') res.write(' ') }, 5)
      res.on('close', () => { responseClosed = true; clearInterval(timer) })
    })
    const startedAt = performance.now()
    await assert.rejects(createLocalDockerPauseTransport(transportOptions, { ...fake, timeoutMs: 40 }), /timed out/)
    assert.ok(performance.now() - startedAt < 400, 'incoming bytes cannot indefinitely rearm the deadline')
    // The server sees the destroyed socket in a later poll phase, not within a
    // fixed 10 ms (red once under load). A request the client never destroyed
    // keeps receiving bytes and never closes, so this bound still fails it.
    const closeDeadline = performance.now() + 2_000
    while (!responseClosed && performance.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(responseClosed, true, 'timeout destroys the active request')
  }
})

test('a timed-out Engine pause still releases an acquired pause and invalidates the observation', async (t) => {
  let paused = false
  let stoppedWith = null
  const fake = await fakeEngine(t, (req, res) => {
    if (req.method === 'GET') sendJson(res, { ...inspection, State: { Paused: paused } })
    else if (req.url.endsWith('/pause')) { paused = true /* ACK deliberately never arrives */ }
    else if (req.url.endsWith('/unpause')) { paused = false; res.writeHead(204); res.end() }
    else { res.writeHead(500); res.end() }
  })
  // One ceiling serves the pause that must time out AND the cleanup unpause
  // that must not. 40 ms failed that unpause once in 15 suite runs beside a
  // root vitest run (2026-10-25), while 400 sequential unpause round trips on
  // this loopback under the same load measured p99 6.9 ms, max 20.2 ms: the
  // red was a starved loop, not a slow request. 500 ms is 25x that maximum.
  const transport = await createLocalDockerPauseTransport(transportOptions, { ...fake, timeoutMs: 500 })
  await assert.rejects(runStandaloneObservation({
    redisName: containerName, cells: [{ name: 'unit-cell-a' }, { name: 'unit-cell-b' }],
    cookie: 'maplespire_session=fixture', beforeMs: 0, pauseMs: 0, recoverMs: 0,
  }, {
    docker: async (command) => { assert.equal(command, 'inspect'); return String(paused) },
    createPauseTransport: async () => transport,
    startObservation: () => ({
      pauseStarted() {}, pauseCompleted() { assert.fail('a timeout cannot supply pause ACK') },
      async stop(value) { stoppedWith = value; return { summary: { measurementValid: false } } },
    }),
  }), /timed out/)
  assert.equal(paused, false)
  assert.deepEqual(fake.requests.filter((entry) => entry.method === 'POST').map((entry) => entry.path), [
    `/v1.40/containers/${id}/pause`, `/v1.40/containers/${id}/unpause`,
  ])
  assert.match(stoppedWith.error.message, /timed out/)
})

test('reassigning the container name cannot make cleanup inspect the replacement instead of the acquired Id', async (t) => {
  let acquiredPaused = false
  const inspectedTargets = []
  const fake = await fakeEngine(t, (req, res) => {
    if (req.method === 'GET') sendJson(res, inspection)
    else {
      acquiredPaused = req.url.endsWith('/pause')
      res.writeHead(204)
      res.end()
    }
  })
  const transport = await createLocalDockerPauseTransport(transportOptions, fake)
  await runStandaloneObservation({
    redisName: containerName, cells: [{ name: 'unit-cell-a' }, { name: 'unit-cell-b' }],
    cookie: 'maplespire_session=fixture', beforeMs: 0, pauseMs: 0, recoverMs: 0,
  }, {
    docker: async (command, _format, _template, target) => {
      assert.equal(command, 'inspect')
      inspectedTargets.push(target)
      // After acquisition the name points to a different, unpaused container.
      // Only the verified Id still describes the pause this invocation owns.
      return String(target === id && acquiredPaused)
    },
    createPauseTransport: async () => transport,
    startObservation: () => ({
      pauseStarted() {}, pauseCompleted() {}, unpauseStarted() {}, unpauseCompleted() {},
      async stop({ error }) { assert.equal(error, null); return { summary: { measurementValid: true } } },
    }),
  })
  assert.equal(acquiredPaused, false)
  assert.deepEqual(inspectedTargets, [containerName, id, id])
  assert.equal(fake.requests.at(-1).path, `/v1.40/containers/${id}/unpause`)
})
