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
import { untilAdmitted } from './fixtures/real-time-void.mjs'

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms))
// Wait for what a test needs, not for the time it usually takes: a starved
// event loop delays the sampler's interval past any fixed sleep. The deadline
// is a give-up bound only.
async function waitFor(condition, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await sleep(5)
  }
}
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
  let result
  try {
    // The Engine clock is read every fourth tick. A fixed sleep(260) admitted
    // with ONE engine sample whenever a tick ran late (measured: ticks at 0, 73,
    // 147, 215, 324 ms), and the refusal skipped stop(), so the leaked interval
    // kept this file's process alive until the harness's 10-minute ceiling.
    await waitFor(() => reads >= 2, 'two Engine clock reads')
    observer.pauseStarted(); observer.pauseCompleted(); observer.unpauseStarted(); observer.unpauseCompleted()
    result = await observer.stop()
  } finally { await observer.stop() }
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
  // The summary assigns each answer to a phase by its ARRIVAL, so the phases
  // below end on readiness bodies that have arrived, counted per source (both
  // cells and the router) and status, never on a fixed duration: the sampler's
  // interval runs late on a starved loop, and the old sleep(1_050) read 9-14
  // paused ticks instead of 15 (40 spinning threads on 32 cores, 2026-10-25),
  // and fell short beside a root vitest run too. Two per source, because a tick fired
  // just before a transition can answer just after it, and an answer can share
  // the transition's millisecond.
  let phase = 'before'
  const arrivals = new Map()
  const arrived = (url, status) => {
    const key = `${phase} ${status} ${String(url).replace(/\/api\/ready$/, '')}`
    arrivals.set(key, (arrivals.get(key) ?? 0) + 1)
  }
  const everySource = (status, n) => ['/a', '/b', ''].every(source =>
    (arrivals.get(`${phase} ${status} ${base}${source}`) ?? 0) >= n)
  const countingFetch = async (url, init) => {
    const response = await fetch(url, init)
    if (!String(url).endsWith('/api/ready')) return response
    const json = response.json.bind(response)
    // The collector stamps the arrival in the same macrotask, after this body.
    response.json = async () => { const body = await json(); arrived(url, response.status); return body }
    return response
  }
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
  }, { fetch: countingFetch, writeReport: (_path, report) => { written = report } })
  t.after(() => observer.stop())
  await waitFor(() => everySource(200, 2), 'healthy pre-pause readiness from both cells and the router')
  observer.pauseStarted()
  paused = true
  observer.pauseCompleted()
  phase = 'paused'
  await waitFor(() => everySource(503, 2) && authenticatedStateReads >= 8, 'paused 503 readiness from every source')
  observer.unpauseStarted()
  paused = false
  observer.unpauseCompleted()
  phase = 'unpaused'
  await waitFor(() => everySource(200, 2), 'healthy post-unpause readiness from both cells and the router')
  const report = await observer.stop()
  assert.equal(report, written)
  assert.equal(report.summary.measurementValid, true, report.summary.measurementIssues.join('; '))
  const during = report.samples.filter((s) => s.t >= report.summary.pausedAtMs && s.t < report.summary.unpauseStartedAtMs)
  const delayed = during.find((s) => s.a.ready.status === 503)
  assert.ok(delayed, 'the HTTP server really returned a delayed 503')
  assert.ok(delayed.a.ready.at - delayed.a.state.at >= 400, 'state answers arrive while the readiness body is still pending')
  // The non-blocking property itself, independent of how late ticks run: new
  // ticks keep firing while that 500 ms readiness body is still outstanding. A
  // sampler that waited on its previous reads would fire none.
  const overlapping = report.samples.filter((s) => s.t > delayed.t && s.t < delayed.a.ready.at)
  assert.ok(overlapping.length >= 3, `the 50 ms sampler must keep polling while readiness is slow (${overlapping.length} ticks)`)
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
  let insideCalls = 0, cellReads = 0
  const observer = startObservation({ ...options(), routerReadyUrl: null }, {
    fetch: async url => { cellReads += 1; return healthyResponse(url) },
    readRouterFromInside: async () => { insideCalls += 1; return { status: 200, body: { checks: { redis: true } }, execMs: 3 } },
  })
  let report
  try {
    // Three ticks (two cells x ready + state each), not sleep(430): a 200 ms
    // interval delayed by 30 ms leaves two samples, which says nothing about routing.
    await waitFor(() => cellReads >= 12, 'three sampler ticks')
    report = await observer.stop()
  } finally { await observer.stop() }
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

test('standalone injector refuses a bad baseline before acquiring a pause; healthy control reaches the transport', async t => {
  for (const badClock of [false, true]) {
    let stateReads, paused, written, changes
    const arm = async () => {
    stateReads = 0; paused = false; written = null; changes = []
    const opts = { ...options(), clockCalibration: true, includeLogs: true, samplePeriodMs: 50,
      out: 'in-memory', beforeMs: 300, pauseMs: 0, recoverMs: 0 }
    return runStandaloneObservation(opts, {
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
    }
    // The bad-clock arm EXPECTS a clock refusal and is never void. The healthy
    // control is void when a fixed 300 ms window on a starved loop held fewer
    // than two Engine reads or no fresh sample (fixtures/real-time-void.mjs).
    if (badClock) await assert.rejects(arm(), /baseline refused before Redis pause/)
    else {
      await untilAdmitted(t, 'healthy standalone control', async () => {
        try { await arm(); return { void: null } } catch (error) {
          if (written?.summary.baseline?.valid === false) return { void: written.summary.baseline.issues }
          throw error
        }
      })
    }
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

test('admission discloses an unfinished Engine read and stop still waits for that original promise', async t => {
  // Void when the loop ran the fourth-tick Engine reads more than 400 ms apart,
  // so the second completed read is stale by the time the third is in flight.
  await untilAdmitted(t, 'held Engine read admission', async () => {
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
    try { observer.pauseStarted() } catch (error) {
      releaseEngine()
      const { summary } = await observer.stop()
      if (summary.baseline?.valid === false) return { void: summary.baseline.issues }
      throw error
    }
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
    return { void: null }
  } finally {
    releaseEngine()
    await observer.stop()
  }
  })
})
