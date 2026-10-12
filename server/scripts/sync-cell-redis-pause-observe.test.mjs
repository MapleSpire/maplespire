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
import { test } from 'node:test'
import { identifyObservationCells, observationOptions, runStandaloneObservation, startObservation, validateRouterReadinessUrl } from './sync-cell-redis-pause-observe.mjs'

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms))
const healthyResponse = async (url) => new Response(JSON.stringify(String(url).includes('sync-cell')
  ? { partitionIndex: 0, ready: true } : { checks: { redis: true } }), { status: 200 })
const options = () => ({
  ...observationOptions([], { SYNC_FAILOVER_PROJECT: 'unit-observe' }),
  cookie: 'maplespire_session=test-only', out: null, includeLogs: false, includeTcpProbe: false,
  routerReadyUrl: 'http://127.0.0.1:3999/api/ready',
})

test('router URL override is restricted to loopback readiness, with no credentials or query', () => {
  assert.equal(validateRouterReadinessUrl(null), null)
  assert.equal(validateRouterReadinessUrl('http://127.0.0.1:3473/api/ready'), 'http://127.0.0.1:3473/api/ready')
  for (const value of [
    '', 'http://example.com/api/ready', 'http://localhost.example.com/api/ready',
    'http://user:secret@127.0.0.1/api/ready', 'file:///api/ready',
    'http://127.0.0.1/api/health', 'http://127.0.0.1/api/ready?q=1', 'http://127.0.0.1/api/ready#x',
  ]) assert.throws(() => validateRouterReadinessUrl(value), /loopback/)
})

test('legacy durations and indirect router remain the default; blank options never become zero', () => {
  const opts = observationOptions([], {})
  assert.equal(opts.beforeMs, 2_000)
  assert.equal(opts.pauseMs, 30_000)
  assert.equal(opts.recoverMs, 25_000)
  assert.equal(opts.routerReadyUrl, null)
  assert.equal(opts.samplePeriodMs, 200)
  assert.equal(opts.engineHost, null)
  assert.equal(observationOptions(['--sample-ms', '50'], {}).samplePeriodMs, 50)
  for (const argv of [['--pause-ms'], ['--pause-ms', ''], ['--pause-ms', '0'], ['--router-ready-url'], ['--sample-ms', '49'], ['--sample-ms', '1001'], ['--sample-ms', ''], ['--engine-host', 'tcp://remote']]) {
    assert.throws(() => observationOptions(argv, {}))
  }
})

test('clock mode is explicit and requires identified distinct containers, Engine and logs', async () => {
  assert.equal(observationOptions([], {}).clockCalibration, false)
  assert.throws(() => observationOptions(['--clock-calibration'], {}), /requires --engine-host/)
  assert.equal(observationOptions(['--clock-calibration', '--engine-host', 'unix:///task.sock'], {}).clockCalibration, true)
  const cells = options().cells
  const identified = await identifyObservationCells(cells, async (_cmd, _flag, _format, name) => `${name === cells[0].name ? 'a'.repeat(64) : 'b'.repeat(64)}\n`)
  assert.equal(identified[0].id, 'a'.repeat(64))
  assert.equal(cells[0].id, undefined, 'identification does not mutate the supplied configuration')
  await assert.rejects(identifyObservationCells(cells, async () => 'a'.repeat(64)), /distinct/)
  await assert.rejects(identifyObservationCells(cells, async () => 'short-id'), /full cell/)
  assert.throws(() => startObservation({ ...options(), cells: identified, clockCalibration: true }), /Engine clock reader/)
})

test('collector preserves request and arrival clocks and propagates incomplete calibration as invalid', async () => {
  const opts = options()
  opts.cells = opts.cells.map((cell, index) => ({ ...cell, id: (index ? 'b' : 'a').repeat(64) }))
  let reads = 0
  const observer = startObservation({ ...opts, samplePeriodMs: 50, clockCalibration: true, includeLogs: true,
    readEngineClock: async () => { reads += 1; return { generatedAt: new Date().toISOString(), version: '29.7.2' } },
  }, {
    fetch: async url => new Response(JSON.stringify(String(url).includes('sync-cell')
      ? { generatedAt: new Date().toISOString(), partitionIndex: 0, ready: true, partitionLossCount: 0 }
      : { checks: { redis: true } })),
    logsSince: cell => ({ containerId: cell.id, lossLines: [], kept: [], totalLines: 0, admissionLines: 0 }),
  })
  await sleep(260)
  observer.pauseStarted(); observer.pauseCompleted(); observer.unpauseStarted(); observer.unpauseCompleted()
  const result = await observer.stop()
  assert.ok(reads >= 2)
  for (const sample of result.samples) {
    const state = sample.a.state
    assert.equal(typeof state.generatedAt, 'string')
    assert.ok(state.requestedAt <= state.at)
    assert.ok(state.requestedMonoAt <= state.monoAt)
  }
  assert.equal(result.summary.clock.verdict, 'INVALID')
  assert.equal(result.summary.measurementValid, false)
  assert.ok(result.summary.measurementIssues.some(issue => issue.startsWith('clock:')))
})

test('real HTTP: slow readiness does not delay state polling, arrivals are recorded after bodies, and stop drains pending reads', async (t) => {
  let paused = false
  let requests = 0
  let authenticatedStateReads = 0
  const server = createServer((req, res) => {
    requests += 1
    const isState = req.url.endsWith('/api/platform/sync-cell')
    const isA = req.url.startsWith('/a/')
    const observedPause = paused
    if (isState && req.headers.cookie === 'maplespire_session=test-only') authenticatedStateReads += 1
    const body = isState
      ? { partitionIndex: observedPause || !isA ? null : 0, ready: !observedPause && isA, canServe: true }
      : { checks: { redis: !observedPause, syncCellConverged: !observedPause && isA } }
    res.writeHead(isState || !observedPause ? 200 : 503, { 'content-type': 'application/json' })
    // Headers arrive immediately, the BODY arrives later. Timestamping fetch's
    // header promise or the request tick misses the observed response delay.
    res.flushHeaders()
    setTimeout(() => res.end(JSON.stringify(body)), !isState && observedPause ? 500 : 5)
  })
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((settle) => server.close(settle))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  let written = null
  const observer = startObservation({
    ...options(), out: 'in-memory', routerReadyUrl: `${base}/api/ready`, samplePeriodMs: 50,
    cells: [{ service: 'a', base: `${base}/a` }, { service: 'b', base: `${base}/b` }],
  }, { writeReport: (_path, report) => { written = report } })
  t.after(() => observer.stop())
  await sleep(250)
  observer.pauseStarted()
  paused = true
  observer.pauseCompleted()
  await sleep(1_050)
  observer.unpauseStarted()
  paused = false
  observer.unpauseCompleted()
  await sleep(250)
  const report = await observer.stop()
  assert.equal(report, written)
  assert.equal(report.summary.measurementValid, true, report.summary.measurementIssues.join('; '))
  const during = report.samples.filter((s) => s.t >= report.summary.pausedAtMs && s.t < report.summary.unpauseStartedAtMs)
  assert.ok(during.length >= 15, `the configured 50 ms sampler must keep polling despite slow readiness (${during.length} ticks)`)
  const delayed = during.find((s) => s.a.ready.status === 503)
  assert.ok(delayed, 'the HTTP server really returned a delayed 503')
  assert.ok(delayed.a.ready.at - delayed.a.state.at >= 400, 'state answers arrive while the readiness body is still pending')
  assert.ok(authenticatedStateReads >= 8, 'the gate cookie reached actual state endpoints on repeated ticks')
  assert.equal(report.summary.samplePeriodMs, 50)
  assert.equal(report.summary.router.samplePeriodMs, 50)
  assert.equal(report.summary.router.sampleCount, report.samples.length)
  assert.ok(report.samples.every((s) => Number.isFinite(s.a.ready.at) && Number.isFinite(s.b.state.at)))
  const requestsAtStop = requests
  await sleep(250)
  assert.equal(requests, requestsAtStop, 'stop must clear the sampler, not merely write a snapshot')
  assert.equal(await observer.stop(), report, 'repeat stop returns the settled report')
})

test('legacy internal-router path remains one in five ticks and carries its slower sample period', async () => {
  let insideCalls = 0
  const observer = startObservation({ ...options(), routerReadyUrl: null }, {
    fetch: healthyResponse,
    readRouterFromInside: async () => { insideCalls += 1; return { status: 200, body: { checks: { redis: true } }, execMs: 3 } },
  })
  await sleep(430)
  const report = await observer.stop()
  assert.ok(report.samples.length >= 3)
  assert.equal(insideCalls, Math.ceil(report.samples.length / 5))
  assert.equal(report.summary.router.samplePeriodMs, 1_000)
  assert.equal(report.summary.measurementValid, false, 'a healthy-only record cannot certify an outage')
})

test('stop waits for the report write and propagates an output failure', async () => {
  let writes = 0
  const observer = startObservation({ ...options(), out: 'not-written' }, {
    fetch: healthyResponse,
    writeReport: async () => { writes += 1; await sleep(20); throw new Error('controlled output failure') },
  })
  await assert.rejects(observer.stop(), /controlled output failure/)
  await assert.rejects(observer.stop(), /controlled output failure/)
  assert.equal(writes, 1)
})

test('invalid/duplicate transitions are refused and a pre-existing pause is never released', async () => {
  const observer = startObservation(options(), { fetch: healthyResponse })
  assert.throws(() => observer.pauseCompleted(), /transition/)
  observer.pauseStarted()
  assert.throws(() => observer.pauseStarted(), /transition/)
  await observer.stop()
  const commands = []
  await assert.rejects(runStandaloneObservation(options(), {
    docker: async (...args) => { commands.push(args); return 'true' },
    startObservation: () => { throw new Error('must not start after refusing an existing pause') },
  }), /already paused/)
  assert.deepEqual(commands.map((args) => args[0]), ['inspect'])
})

test('a marker failure invalidates the record but cannot prevent unpausing the container we acquired', async () => {
  let paused = false
  let stoppedWith = null
  const commands = []
  await assert.rejects(runStandaloneObservation({ ...options(), beforeMs: 0, pauseMs: 0, recoverMs: 0 }, {
    docker: async (command) => {
      commands.push(command)
      if (command === 'inspect') return String(paused)
      if (command === 'pause') paused = true
      if (command === 'unpause') paused = false
      return ''
    },
    startObservation: () => ({
      pauseStarted() {}, pauseCompleted() {},
      unpauseStarted() { throw new Error('clock moved backwards') },
      async stop(value) { stoppedWith = value; return { summary: { measurementValid: false } } },
    }),
  }), /timestamp failed/)
  assert.equal(paused, false)
  assert.equal(commands.filter((command) => command === 'unpause').length, 1)
  assert.ok(stoppedWith.error, 'the failure is preserved in the observation, not swallowed after cleanup')
})

test('failed cleanup inspection cannot suppress release after the pause acknowledgement', async () => {
  let paused = false
  let inspections = 0
  let stoppedWith = null
  const commands = []
  await assert.rejects(runStandaloneObservation({ ...options(), beforeMs: 0, pauseMs: 0, recoverMs: 0 }, {
    docker: async (command) => {
      commands.push(command)
      if (command === 'inspect') {
        inspections += 1
        if (inspections === 3) throw new Error('controlled cleanup inspection failure')
        return String(paused)
      }
      if (command === 'pause') paused = true
      if (command === 'unpause') paused = false
      return ''
    },
    startObservation: () => ({
      pauseStarted() {}, pauseCompleted() {}, unpauseStarted() {}, unpauseCompleted() {},
      async stop(value) { stoppedWith = value; return { summary: { measurementValid: false } } },
    }),
  }), /cleanup inspection failed/)
  assert.equal(paused, false)
  assert.equal(commands.filter((command) => command === 'unpause').length, 1)
  assert.ok(stoppedWith.error, 'failed inspection invalidates the observation even when unpause succeeds')
})

test('standalone injector refuses a bad baseline before acquiring a pause; healthy control reaches the transport', async () => {
  for (const badClock of [false, true]) {
    let stateReads = 0, paused = false, written = null
    const changes = []
    const opts = { ...options(), clockCalibration: true, includeLogs: true, samplePeriodMs: 50,
      out: 'in-memory', beforeMs: 300, pauseMs: 0, recoverMs: 0 }
    const pendingRun = runStandaloneObservation(opts, {
      docker: async (_command, _flag, format, target) => format === '{{.Id}}'
        ? (target === opts.cells[0].name ? 'a' : 'b').repeat(64) : String(paused),
      createPauseTransport: async () => ({ evidence: { engineContainerId: 'c'.repeat(64) },
        readClock: async () => ({ version: '29.7.2', generatedAt: new Date().toISOString() }),
        change: async operation => { changes.push(operation); paused = operation === 'pause' },
      }),
      // The real sampler and the real standalone try/finally meet here.
      startObservation: actual => startObservation(actual, {
        monotonicNow: () => Date.now() + (badClock && stateReads >= 4 ? 10 : 0),
        fetch: async url => {
          if (String(url).includes('sync-cell')) stateReads += 1
          return new Response(JSON.stringify(String(url).includes('sync-cell')
            ? { generatedAt: new Date().toISOString(), partitionIndex: 0, ready: true, partitionLossCount: 0 }
            : { checks: { redis: true } }))
        },
        logsSince: cell => ({ containerId: cell.id, kept: [], lossLines: [], admissionLines: 0, totalLines: 0 }),
        writeReport: (_path, report) => { written = report },
      }),
    })
    if (badClock) await assert.rejects(pendingRun, /baseline refused before Redis pause/)
    else await pendingRun
    assert.deepEqual(changes, badClock ? [] : ['pause', 'unpause'])
    assert.equal(paused, false)
    assert.equal(written.summary.baseline.valid, !badClock)
    if (badClock) {
      assert.equal(written.summary.pauseStartedAtMs, null)
      assert.equal(written.summary.measurementValid, false)
    }
    const readsAtStop = stateReads
    await sleep(70)
    assert.equal(stateReads, readsAtStop, 'the original collector timer is stopped on both paths')
  }
})

test('admission discloses an unfinished Engine read and stop still waits for that original promise', async () => {
  let releaseEngine, engineReads = 0
  const heldEngine = new Promise(resolve => { releaseEngine = resolve })
  const opts = options()
  const observer = startObservation({ ...opts, clockCalibration: true, includeLogs: true, samplePeriodMs: 50,
    cells: opts.cells.map((cell, index) => ({ ...cell, id: (index ? 'b' : 'a').repeat(64) })),
    readEngineClock: async () => {
      engineReads += 1
      const generatedAt = new Date().toISOString()
      if (engineReads === 3) await heldEngine
      return { generatedAt, version: '29.7.2' }
    },
  }, {
    monotonicNow: Date.now,
    fetch: async () => new Response(JSON.stringify({ generatedAt: new Date().toISOString(), checks: { redis: true } })),
    logsSince: cell => ({ containerId: cell.id, kept: [], lossLines: [], admissionLines: 0, totalLines: 0 }),
  })
  try {
    const deadline = Date.now() + 3_000
    while (engineReads < 3 && Date.now() < deadline) await sleep(5)
    assert.equal(engineReads, 3, 'the intended Engine request is actually in flight')
    observer.pauseStarted()
    let settled = false
    const stopped = observer.stop().then(report => { settled = true; return report })
    await sleep(30)
    assert.equal(settled, false, 'stop must not merely abandon the original pending request')
    releaseEngine()
    const report = await stopped
    assert.equal(report.summary.baseline.valid, true)
    assert.equal(report.summary.baseline.sources.engine.pending, 1)
    assert.equal(report.summary.baseline.sources.engine.completed, 2)
    assert.equal(report.samples.filter(sample => sample.engineClock?.generatedAt).length, 3)
    assert.ok(report.samples.every(sample => !sample.engineClock?.pending))
    assert.equal(report.summary.measurementValid, false, 'preflight admission does not qualify a missing outage')
  } finally {
    releaseEngine()
    await observer.stop()
  }
})
