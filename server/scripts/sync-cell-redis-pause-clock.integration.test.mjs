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
import test from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { startObservation } from './sync-cell-redis-pause-observe.mjs'
import { analyzeRedisPauseClock as analyze } from './sync-cell-redis-pause-clock.mjs'

const loss = '[sync-cell] partition-worker-redis-unavailable failed: Error: partition lease keeper lost authority'

test('real HTTP collector preserves source timestamp and actual request/body arrival, then wires calibrated verdict', async () => {
  let down = false, everLost = false, lossLine = null, firstState = null, phase = 'before'
  const clockReads = { before: 0, during: 0, after: 0 }
  const calibratedPhase = async name => {
    const deadline = Date.now() + 5000
    while (clockReads[name] < 3 && Date.now() < deadline) await delay(20)
    assert.ok(clockReads[name] >= 3, `real Engine clock fixture lacks samples in ${name}`)
  }
  const sockets = new Set(), timers = new Set()
  const sourceTime = () => new Date(Date.now() + 200).toISOString()
  const server = http.createServer((request, response) => {
    const generatedAt = sourceTime()
    let body
    if (request.url === '/engine') body = { generatedAt, version: '29.7.2' }
    else if (request.url.endsWith('/api/ready')) {
      response.statusCode = down ? 503 : 200
      body = { checks: { redis: !down } }
    } else {
      const owner = request.url.startsWith('/a/') && !down
      body = { generatedAt, partitionIndex: owner ? 0 : null, ready: owner,
        partitionLossCount: request.url.startsWith('/a/') ? (everLost ? 8 : 7) : 3 }
      if (!firstState && request.url.startsWith('/a/')) {
        firstState = generatedAt
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.flushHeaders()
        const timer = setTimeout(() => { timers.delete(timer); response.end(JSON.stringify(body)) }, 120)
        timers.add(timer)
        return
      }
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(body))
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const cells = ['a', 'b'].map(key => ({ service: key, name: `qa-${key}`, id: key.repeat(64), base: `${base}/${key}` }))
  let observation, report
  try {
    observation = startObservation({ cells, cookie: 'qa=1', routerReadyUrl: `${base}/api/ready`,
      clockCalibration: true, samplePeriodMs: 50, includeTcpProbe: false,
      readEngineClock: async () => {
        const requestedPhase = phase
        const body = await (await fetch(`${base}/engine`)).json()
        clockReads[requestedPhase] += 1
        return body
      },
    }, { logsSince: cell => ({ containerId: cell.id, kept: [], admissionLines: 0, totalLines: 1,
      lossLines: cell.service === 'a' && lossLine ? [lossLine] : [] }) })
    await calibratedPhase('before')
    observation.pauseStarted(); observation.pauseCompleted(); phase = 'during'
    await delay(100); down = true; everLost = true; lossLine = `${sourceTime()} ${loss}`
    await calibratedPhase('during')
    observation.unpauseStarted(); down = false; observation.unpauseCompleted(); phase = 'after'
    await calibratedPhase('after')
    report = await observation.stop()
    assert.equal(report.summary.clock?.valid, true, JSON.stringify(report.summary.clock))
    assert.equal(report.summary.clock.verdict, 'PASS')
    const first = report.samples[0].a.state
    assert.equal(first.generatedAt, firstState)
    assert.ok(first.at - first.requestedAt >= 110, JSON.stringify(first))
    assert.ok(first.monoAt - first.requestedMonoAt >= 110)
    assert.ok(report.samples.some(row => row.engineClock?.generatedAt))
    const count = report.samples.length
    await delay(70)
    assert.equal(report.samples.length, count, 'collector stopped before return')
  } finally {
    try {
      if (observation) await observation.stop({ error: report ? null : new Error('QA assertion or collection failed') })
    } finally {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    }
  }
})

const t0 = Date.UTC(2026, 8, 6)
const iso = (relative) => new Date(t0 + relative).toISOString()
function fixture() {
  const samples = [100, 400, 1100, 1440, 1800, 2200, 3100, 3400].map((s) => {
    const timing = { requestedAt: s, at: s + 2, requestedMonoAt: s, monoAt: s + 2, generatedAt: iso(s + 201) }
    const down = s >= 1440 && s < 3000
    return {
      t: s,
      a: { state: { ...timing, status: 200, partitionIndex: down ? null : 0, ready: !down, partitionLossCount: s >= 1440 ? 8 : 7 } },
      b: { state: { ...timing, status: 200, partitionIndex: null, ready: false, partitionLossCount: 3 } },
      engineClock: { ...timing, version: '29.7.2' },
    }
  })
  samples[3].a.state.at += 200
  samples[3].a.state.monoAt += 200
  return {
    t0, pauseStartedAt: t0 + 1000, pausedAt: t0 + 1020,
    unpauseStartedAt: t0 + 3000, unpausedAt: t0 + 3020,
    samples,
    cells: [{ service: 'cell-a', id: 'a'.repeat(64) }, { service: 'cell-b', id: 'b'.repeat(64) }],
    logs: { 'cell-a': { containerId: 'a'.repeat(64), lossLines: [`${iso(1610)} ${loss}`] } },
  }
}

function invalid(input) { const result = analyze(input); assert.equal(result.valid, false, JSON.stringify(result)); assert.equal(result.verdict, 'INVALID'); return result }

test('a loss needs null partition, ready false and HTTP 200 together in one snapshot', () => {
  for (const mutate of [
    value => { value.ready = true },
    value => { value.status = 503 },
    value => { value.partitionIndex = 0 },
  ]) {
    const input = fixture()
    for (const row of input.samples.filter(row => row.t >= 1440 && row.t < 3000)) mutate(row.a.state)
    invalid(input)
  }
})

test('real logsSince call preserves raw stdout/stderr independently of filtered evidence and pins container IDs', async () => {
  const original = childProcess.spawnSync
  const calls = []
  const stdout = `prefix ${String.fromCharCode(0)} suffix\n`
  const stderr = '2026-09-06T00:00:00.100Z [sync-cell] partition-worker-redis-unavailable failed: Error: partition lease keeper lost authority\n'
  childProcess.spawnSync = (command, args) => {
    assert.equal(command, 'docker'); assert.equal(args[0], 'logs')
    calls.push(args.at(-1))
    return { status: 0, stdout, stderr }
  }
  syncBuiltinESMExports()
  let observation
  try {
    observation = startObservation({ cells: ['a','b'].map(key=>({ service:key, name:`qa-${key}`,id:key.repeat(64),base:`http://qa.invalid/${key}` })),
      cookie:'qa=1', includeTcpProbe:false,
    }, { fetch: async()=>({ok:true,status:200,json:async()=>({checks:{redis:true},partitionIndex:null,ready:false})}),
      readRouterFromInside: async()=>({status:200,body:{checks:{redis:true}}}),
    })
    const report = await observation.stop()
    assert.deepEqual(calls,['a'.repeat(64),'b'.repeat(64)])
    for (const entry of Object.values(report.logs)) {
      assert.equal(entry.rawStdout,stdout)
      assert.equal(entry.rawStderr,stderr)
      assert.deepEqual(entry.lossLines,[stderr.trimEnd()])
    }
  } finally {
    try {
      if (observation) await observation.stop()
    } finally {
      childProcess.spawnSync = original
      syncBuiltinESMExports()
    }
  }
})
