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
import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { startB514Observation } from './b514-observe.mjs'

const BOOT_A = '00000000-0000-4000-8000-000000000001'
const BOOT_B = '00000000-0000-4000-8000-000000000002'
const COOKIE = 'session=synthetic-observer-fixture'
const STATE = { cellId: 'api', partitionIndex: 0, partitionCount: 1, canServe: true,
  partitionReady: true, partitionLossCount: 0, partitionAcquisitionCount: 1,
  configuredGeneration: 'fixture-generation', effectiveGeneration: 'fixture-generation.ce1461953e2b8ac2',
  topologyGeneration: 'fixture-generation.ce1461953e2b8ac2', topologyKeyCreatedAtBoot: true,
  bootObservedAt: '2026-09-07T10:00:00.000Z', storageFence: { rejectedMutationCount: 0 } }

function json(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'keep-alive' })
  response.end(JSON.stringify(body))
}
function healthy(request, response) {
  json(response, request.url.endsWith('/stats') ? { processBootId: BOOT_A }
    : request.url.endsWith('/sync-cell') ? STATE : { checks: { redis: true } })
}
async function until(predicate, timeoutMs = 2000) {
  const start = performance.now()
  while (!predicate() && performance.now() - start < timeoutMs) await delay(5)
  assert.ok(predicate(), 'bounded fixture condition was not observed')
}
async function fixture(t, handler = healthy) {
  const servers = [], sockets = new Set(), received = [], active = new Map(), maximum = new Map()
  let observer
  t.after(async () => {
    if (observer) await observer.stop().catch(() => undefined)
    for (const server of servers) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
  for (let index = 0; index < 3; index++) {
    const server = createServer((request, response) => {
      received.push({ index, path: request.url, cookie: request.headers.cookie, connection: request.headers.connection })
      const channel = index + (request.url.endsWith('/ready') ? '/ready' : '/ownership')
      active.set(channel, (active.get(channel) ?? 0) + 1)
      maximum.set(channel, Math.max(maximum.get(channel) ?? 0, active.get(channel)))
      response.once('close', () => active.set(channel, active.get(channel) - 1))
      handler(request, response, index)
    })
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
  }
  const urls = servers.map(server => 'http://127.0.0.1:' + server.address().port)
  const options = { cells: [{ service: 'api', baseUrl: urls[0] }, { service: 'api-b', baseUrl: urls[1] }],
    routerUrl: urls[2], cookie: COOKIE, onRecord: () => {}, periodMs: 50, timeoutMs: 3000 }
  return { sockets, received, maximum, urls, options,
    start(overrides = {}) { observer = startB514Observation({ ...options, ...overrides }); return observer },
    async stopped() {
      const result = await observer.stop()
      assert.deepEqual(result.transport, { requestsRemaining: 0, socketsRemaining: 0 })
      // Peer close can be delivered after local close. Wait for that real event;
      // the test never closes a fixture socket before making this assertion.
      await until(() => sockets.size === 0)
      return result
    },
  }
}

test('a real 503 after 1500 ms remains observable while ownership progresses independently', { timeout: 7000 }, async t => {
  const f = await fixture(t, (request, response, index) => {
    if (index === 0 && request.url.endsWith('/ready')) {
      const timer = setTimeout(() => json(response, { checks: { redis: false } }, 503), 1500)
      response.once('close', () => clearTimeout(timer))
    } else healthy(request, response)
  })
  const observer = f.start()
  await until(() => observer.records.some(record => record.channel === 'api/ready' && record.status === 503), 5000)
  await f.stopped()
  const sample = observer.records.find(record => record.channel === 'api/ready' && record.status === 503)
  assert.equal(sample.error, null)
  assert.equal(sample.checks.redis, false)
  assert.ok(sample.ended - sample.began >= 1450)
  assert.ok(sample.closedAt >= sample.ended)
  const ownersDuring = observer.records.filter(record => record.channel === 'api/ownership' && record.ended < sample.ended)
  assert.ok(ownersDuring.length >= 5, 'ownership does not await the slow readiness response')
  assert.ok([...f.maximum.values()].every(count => count === 1), 'one outstanding call per channel')
  assert.ok(observer.records.every((record, index, records) => index === 0 || record.at >= records[index - 1].at))
  assert.ok(f.received.every(request => request.connection === 'close'))
})

test('stop closes completed and pending real HTTP transports, and is idempotent', async t => {
  const f = await fixture(t, (request, response, index) => {
    if (index === 0 && request.url.endsWith('/ready')) return
    healthy(request, response)
  })
  const observer = f.start()
  await until(() => observer.records.some(record => record.channel === 'api/ownership') && f.sockets.size > 0)
  const stopping = observer.stop()
  assert.equal(observer.stop(), stopping)
  const result = await f.stopped()
  assert.ok(result.records.some(record => record.channel === 'api/ready' && record.error === 'aborted' && record.status === null))
  const count = f.received.length
  await delay(80)
  assert.equal(f.received.length, count, 'no request can start after stop')
  assert.throws(() => observer.mark('late'), /stopped/)
})

test('a collector writer failure rejects only after every HTTP transport closes', async t => {
  const f = await fixture(t, (request, response) => {
    if (request.url.endsWith('/ready')) return
    healthy(request, response)
  })
  const failure = new Error('synthetic record writer failed')
  const observer = f.start({ onRecord: () => { throw failure } })
  await assert.rejects(observer.done, error => error === failure)
  await assert.rejects(observer.stop(), error => error === failure)
  await until(() => f.sockets.size === 0)
  const count = f.received.length
  await delay(80)
  assert.equal(f.received.length, count)
})

test('ownership carries exact boot brackets and boot/topology correlation fields', async t => {
  const f = await fixture(t)
  const observer = f.start()
  await until(() => observer.records.some(record => record.channel === 'api/ownership'))
  await f.stopped()
  const sample = observer.records.find(record => record.channel === 'api/ownership' && record.identityValid)
  assert.equal(sample.beforeBoot.id, BOOT_A)
  assert.equal(sample.afterBoot.id, BOOT_A)
  assert.equal(sample.identityChanged, false)
  assert.ok(sample.beforeBoot.ended <= sample.began && sample.ended <= sample.afterBoot.began)
  assert.equal(sample.state.topologyGeneration, STATE.topologyGeneration)
  assert.equal(sample.state.configuredGeneration, 'fixture-generation')
  assert.equal(sample.state.effectiveGeneration, 'fixture-generation.ce1461953e2b8ac2')
  assert.equal(sample.state.partitionCount, 1)
  assert.equal(sample.state.bootObservedAt, STATE.bootObservedAt)
  assert.deepEqual(sample.state.storageFence, STATE.storageFence)
})

test('a boot changing within an ownership bracket is invalid, and between brackets is reported', async t => {
  let stats = 0
  const f = await fixture(t, (request, response, index) => {
    if (index === 0 && request.url.endsWith('/stats')) {
      stats++
      json(response, { processBootId: stats <= 3 ? BOOT_A : BOOT_B })
    } else healthy(request, response)
  })
  const observer = f.start()
  await until(() => observer.records.filter(record => record.channel === 'api/ownership').length >= 3)
  await f.stopped()
  const samples = observer.records.filter(record => record.channel === 'api/ownership')
  assert.equal(samples[0].identityValid, true)
  assert.equal(samples[1].identityValid, false)
  assert.equal(samples[1].identityChanged, true)
  assert.equal(samples[1].beforeBoot.id, BOOT_A)
  assert.equal(samples[1].afterBoot.id, BOOT_B)
  assert.equal(samples[2].identityValid, true)
  assert.equal(samples[2].identityChanged, true)
  assert.equal(samples[2].previousProcessBootId, BOOT_A)
})

test('empty, absent and malformed process identities never validate; absent state fields stay absent', async t => {
  let id = ''
  const f = await fixture(t, (request, response) => {
    json(response, request.url.endsWith('/stats') ? { processBootId: id } : {})
  })
  const observer = f.start()
  for (const value of ['', undefined, 'not-a-uuid']) {
    id = value
    await until(() => observer.records.some(record => record.channel === 'api/ownership' && record.beforeBoot.id === (value ?? null)))
  }
  await f.stopped()
  const samples = observer.records.filter(record => record.channel.endsWith('/ownership'))
  assert.ok(samples.length >= 3)
  assert.ok(samples.every(record => !record.identityValid))
  assert.ok(samples.filter(record => record.status === 200)
    .every(record => !Object.hasOwn(record.state, 'partitionCount') && !Object.hasOwn(record.state, 'bootObservedAt')))
  assert.ok(samples.filter(record => record.status === null).every(record => record.state === null))
})

test('all arguments are validated before I/O; credentials cannot target non-loopback origins', async t => {
  const f = await fixture(t)
  const bad = [
    { cells: [] }, { cells: [f.options.cells[0], f.options.cells[0]] },
    { cells: [{ service: 'router', baseUrl: f.urls[0] }, f.options.cells[1]] },
    { routerUrl: 'http://example.com' }, { routerUrl: 'http://192.0.2.1' },
    { routerUrl: 'http://127.0.0.1.example.com' }, { routerUrl: 'https://127.0.0.1' },
    { cells: [{ service: 'api', baseUrl: 'http://192.0.2.1' }, f.options.cells[1]] },
    { routerUrl: 'http://name:password@127.0.0.1' }, { routerUrl: f.urls[2] + '/prefix' },
    { routerUrl: f.urls[2] + '/?a=b' }, { routerUrl: f.urls[2] + '/#fragment' },
    { routerUrl: f.urls[0] }, { cookie: '' }, { cookie: 'x' + String.fromCharCode(13, 10) + 'Injected: value' },
    { timeoutMs: 2999 }, { timeoutMs: Infinity }, { periodMs: 49 }, { periodMs: 1001 },
    { maxBodyBytes: 0 }, { maxBodyBytes: 2 * 1024 * 1024 + 1 }, { onRecord: null }, { now: () => NaN },
  ]
  for (const override of bad) assert.throws(() => startB514Observation({ ...f.options, ...override }))
  assert.throws(() => startB514Observation())
  await delay(30)
  assert.equal(f.received.length, 0)
  assert.equal(f.sockets.size, 0)
})

test('localhost is pinned to loopback and cookies appear only on authenticated ownership reads', async t => {
  const f = await fixture(t)
  const observer = f.start({ cells: f.options.cells.map(cell => ({ ...cell, baseUrl: cell.baseUrl.replace('127.0.0.1', 'localhost') })) })
  await until(() => observer.records.some(record => record.channel === 'api/ownership'))
  await f.stopped()
  assert.ok(f.received.some(request => request.cookie === COOKIE))
  assert.ok(f.received.filter(request => request.path.endsWith('/ready')).every(request => request.cookie === undefined))
  assert.ok(f.received.filter(request => !request.path.endsWith('/ready')).every(request => request.cookie === COOKIE))
  assert.ok(!JSON.stringify(observer.records).includes(COOKIE))
})

test('redirects are refused, including same-loopback destinations; the cookie is never forwarded', async t => {
  let destinationHits = 0
  const target = createServer((request, response) => { destinationHits++; response.end('{}') })
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => target.close(resolve)))
  const f = await fixture(t, (request, response) => {
    if (request.url.endsWith('/stats')) {
      response.writeHead(302, { Location: 'http://127.0.0.1:' + target.address().port + '/stolen' })
      response.end('{}')
    } else healthy(request, response)
  })
  const observer = f.start()
  await until(() => observer.records.some(record => record.channel === 'api/ownership'))
  await f.stopped()
  const sample = observer.records.find(record => record.channel === 'api/ownership')
  assert.equal(sample.identityValid, false)
  assert.equal(sample.beforeBoot.error, 'redirect-refused')
  assert.equal(sample.beforeBoot.status, null)
  assert.equal(destinationHits, 0)
})

test('a real timeout after 503 headers is unknown, never a completed 503 observation', { timeout: 7000 }, async t => {
  const f = await fixture(t, (request, response, index) => {
    if (index === 0 && request.url.endsWith('/ready')) {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.flushHeaders()
    } else healthy(request, response)
  })
  const observer = f.start({ periodMs: 500 })
  await until(() => observer.records.some(record => record.channel === 'api/ready' && record.error === 'timeout'), 5000)
  await f.stopped()
  const sample = observer.records.find(record => record.channel === 'api/ready' && record.error === 'timeout')
  assert.equal(sample.status, null)
  assert.equal(sample.responseStatus, 503)
  assert.equal(sample.checks, null)
  assert.ok(sample.ended - sample.began >= 2900)
})

test('body limits apply while streaming, and malformed JSON cannot supply health or identity', async t => {
  const f = await fixture(t, (request, response, index) => {
    if (request.url.endsWith('/ready')) {
      response.writeHead(503)
      if (index === 0) response.write('x'.repeat(129))
      else response.end('not-json')
    } else if (request.url.endsWith('/stats')) json(response, [])
    else healthy(request, response)
  })
  const observer = f.start({ maxBodyBytes: 128 })
  await until(() => observer.records.some(record => record.channel === 'api/ready')
    && observer.records.some(record => record.channel === 'api/ownership')
    && observer.records.some(record => record.channel === 'router/ready'))
  await f.stopped()
  const oversized = observer.records.find(record => record.channel === 'api/ready')
  assert.equal(oversized.error, 'body-too-large')
  assert.equal(oversized.status, null)
  assert.equal(oversized.checks, null)
  assert.equal(observer.records.find(record => record.channel === 'router/ready').error, 'invalid-json')
  assert.equal(observer.records.find(record => record.channel === 'api/ownership').beforeBoot.error, 'invalid-json-object')
})

test('a monotonic clock failure shuts down the real collector without continued sampling', async t => {
  let calls = 0
  const f = await fixture(t, (request, response) => {
    if (request.url.endsWith('/ready')) return
    healthy(request, response)
  })
  const observer = f.start({ now: () => ++calls < 18 ? calls : -1 })
  await assert.rejects(observer.done, /monotonic observer clock/)
  await assert.rejects(observer.stop(), /monotonic observer clock/)
  await until(() => f.sockets.size === 0)
})

test('a connection closed after a partial 503 body does not count as a 503 observation', async t => {
  const f = await fixture(t, (request, response, index) => {
    if (index === 0 && request.url.endsWith('/ready')) {
      response.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': 1000 })
      response.write('{"checks":')
      const timer = setTimeout(() => response.destroy(), 15)
      response.once('close', () => clearTimeout(timer))
    } else healthy(request, response)
  })
  const observer = f.start()
  await until(() => observer.records.some(record => record.channel === 'api/ready'))
  await f.stopped()
  const sample = observer.records.find(record => record.channel === 'api/ready')
  assert.equal(sample.status, null)
  assert.equal(sample.responseStatus, 503)
  assert.ok(['incomplete-response', 'response-failed'].includes(sample.error))
  assert.equal(sample.checks, null)
})

test('a mark writer failure also aborts pending requests and preserves the failure', async t => {
  const f = await fixture(t, () => {})
  const error = new Error('synthetic mark writer failure')
  const observer = f.start({ onRecord: record => { if (record.kind === 'mark') throw error } })
  await until(() => f.received.length === 5)
  assert.throws(() => observer.mark('fault-begin', { fixture: true }), value => value === error)
  await assert.rejects(observer.done, value => value === error)
  await until(() => f.sockets.size === 0)
})

test('an asynchronous record writer is rejected with cleanup, not left with an unhandled promise', async t => {
  const f = await fixture(t)
  const observer = f.start({ onRecord: async () => { throw new Error('synthetic async writer') } })
  await assert.rejects(observer.done, /onRecord must be synchronous/)
  await until(() => f.sockets.size === 0)
})

test('immediate stop starts no transport or timer-driven sample', async t => {
  const f = await fixture(t)
  const observer = f.start()
  const result = await f.stopped()
  assert.equal(result.records.length, 0)
  assert.equal(f.received.length, 0)
  assert.deepEqual(await observer.done, result)
})
