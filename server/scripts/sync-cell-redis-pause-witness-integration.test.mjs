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
import { createServer, createConnection } from 'node:net'
import { observationOptions, runStandaloneObservation, startObservation, refineRedisPauseClock } from './sync-cell-redis-pause-observe.mjs'
import { startRedisFreezeWitness } from './sync-cell-redis-pause-witness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const target = {
  containerId: 'c'.repeat(64), imageId: `sha256:${'d'.repeat(64)}`, startedAt: '2026-09-06T00:00:00.000Z',
  restartCount: 0, project: 'unit-witness', service: 'redis',
  networkName: 'unit-network', networkId: 'e'.repeat(64), ip: '127.0.0.1', port: 6379,
}
function options() {
  return { ...observationOptions(['--engine-host', 'unix:///qa-unused.sock', '--clock-calibration',
    '--redis-witness-network', 'unit-network', '--sample-ms', '50'], { SYNC_FAILOVER_PROJECT: 'unit-witness' }),
  cookie: 'maplespire_session=fixture', out: null, includeTcpProbe: false, includeLogs: true,
  cells: [{ service: 'a', name: 'unit-a', id: 'a'.repeat(64), base: 'http://127.0.0.1:1/a' },
    { service: 'b', name: 'unit-b', id: 'b'.repeat(64), base: 'http://127.0.0.1:1/b' }],
  redisWitnessTarget: target, verifyWitnessIdentity: async () => ({ valid: true, initial: target, final: target }),
  readEngineClock: async () => ({ generatedAt: new Date().toISOString(), version: '29.7.2' }),
  routerReadyUrl: 'http://127.0.0.1:1/api/ready',
  }
}
const log = cell => ({ containerId: cell.id, kept: [], lossLines: [], admissionLines: 0, totalLines: 0 })
const fetch = async () => new Response(JSON.stringify({ generatedAt: new Date().toISOString(), checks: { redis: true } }))

async function echoServer(t, onRequest = (_nonce, reply) => reply()) {
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    let bytes = Buffer.alloc(0)
    socket.on('data', chunk => {
      bytes = Buffer.concat([bytes, chunk])
      assert.ok(bytes.length < 512, 'fixture only accepts a bounded PING frame')
      const match = /^\*2\r\n\$4\r\nPING\r\n\$(\d+)\r\n/.exec(bytes.toString('ascii'))
      if (!match) return
      const size = Number(match[1]), header = Buffer.byteLength(match[0])
      if (bytes.length < header + size + 2) return
      assert.equal(bytes.length, header + size + 2, 'one command in flight')
      assert.equal(bytes.subarray(-2).toString(), '\r\n')
      const nonce = bytes.subarray(header, header + size).toString('ascii')
      bytes = Buffer.alloc(0)
      onRequest(nonce, () => socket.write(`$${size}\r\n${nonce}\r\n`))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  return { ...target, port: server.address().port }
}
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('TCP fixture did not reach its intended event')), 5000)
  })]) } finally { clearTimeout(timer) }
}

test('real observer plus real TCP witness: a normal stop preserves a valid witness artifact', async t => {
  const tcpTarget = await echoServer(t)
  const base = Date.now(), start = performance.now()
  const now = () => base + Math.floor(performance.now() - start)
  const observer = startObservation({ ...options(), redisWitnessTarget: tcpTarget,
    verifyWitnessIdentity: async () => ({ valid: true, initial: tcpTarget, final: tcpTarget }),
    readEngineClock: async () => ({ version: '29.7.2', generatedAt: new Date(now()).toISOString() }),
  }, { now, monotonicNow: now, logsSince: log,
    fetch: async () => new Response(JSON.stringify({ generatedAt: new Date(now()).toISOString(), checks: { redis: true } })),
  })
  try {
    await sleep(260)
    observer.pauseStarted(); observer.pauseCompleted()
    await sleep(20)
    observer.sealBeforeUnpause(); observer.unpauseStarted(); observer.unpauseCompleted()
    const report = await observer.stop()
    assert.equal(report.summary.pauseAdmission.valid, true)
    assert.equal(report.freezeWitness.instrumentValid, true, JSON.stringify(report.freezeWitness.issues))
    assert.equal(report.freezeWitness.cleanup.cleanupConfirmed, true)
    assert.ok(report.freezeWitness.records.length >= 2)
    assert.equal(report.summary.freezeWitness.valid, false, 'no ownership loss was simulated, so this is not an outage qualification')
  } finally { await observer.stop() }
})

test('real PING confirmed after ACK improves only the departure bound; the historical interval remains intact', async t => {
  let hold = false, releaseReply, notifyHeld, notifyBaseline, notifyReply
  const held = new Promise(resolve => { notifyHeld = resolve })
  const baseline = new Promise(resolve => { notifyBaseline = resolve })
  const replyArrived = new Promise(resolve => { notifyReply = resolve })
  const tcpTarget = await echoServer(t, (_nonce, reply) => {
    if (hold) { releaseReply = reply; notifyHeld() } else reply()
  })
  let at = 990, ordinal = 0, replies = 0
  const witness = startRedisFreezeWitness({ target: tcpTarget, clock: () => ({ at, monoAt: at, ordinal: ++ordinal }) }, {
    connect: args => {
      const socket = createConnection(args)
      socket.on('data', () => {
        replies += 1
        if (replies === 3) notifyBaseline()
        if (replies === 4) notifyReply()
      })
      return socket
    },
  })
  try {
    await bounded(baseline)
    hold = true; at = 1000
    assert.equal(witness.admissionBeforePause().valid, true)
    witness.pauseAttempted()
    at = 1010
    await bounded(held)
    at = 1020; witness.pauseAcknowledged()
    at = 1030; releaseReply()
    await bounded(replyArrived)
    at = 1040; witness.sealBeforeUnpause()
    at = 1050
    const artifact = await witness.stop()
    assert.equal(artifact.instrumentValid, true, JSON.stringify(artifact.issues))
    const clock = { valid: true, transition: { lowerMs: 416, upperMs: 483 }, verdict: 'INCONCLUSIVE' }
    const original = structuredClone(clock)
    const identity = { valid: true, initial: tcpTarget, final: tcpTarget }
    const refined = refineRedisPauseClock({ clock, witness: artifact, pauseBegin: 1000, identity })
    assert.equal(refined.gainMs, 9, '1010 departure minus 1 ms quantization minus 1000 historical origin')
    assert.deepEqual(refined.transition, { lowerMs: 416, upperMs: 474 })
    assert.equal(refined.verdict, 'PASS')
    assert.deepEqual(clock, original)
    assert.equal(refineRedisPauseClock({ clock, witness: artifact, pauseBegin: 1100, identity }).gainMs, 0)
    assert.equal(refineRedisPauseClock({ clock, witness: artifact, pauseBegin: 1000, identity: { valid: false } }).valid, false)
    assert.equal(refineRedisPauseClock({ clock, witness: artifact, pauseBegin: 1000,
      identity: { ...identity, final: { ...tcpTarget, ip: '127.0.0.2' } } }).valid, false)
    assert.equal(refineRedisPauseClock({ clock: { ...clock, valid: false }, witness: artifact, pauseBegin: 1000, identity }).valid, false)
    assert.equal(refineRedisPauseClock({ clock: { ...clock, transition: { lowerMs: 480, upperMs: 483 } }, witness: artifact, pauseBegin: 1000, identity }).valid, false)
  } finally { await witness.stop() }
})

test('witness option requires calibration, an explicit network and a matching verified target', () => {
  assert.equal(observationOptions([], {}).redisWitnessNetwork, null)
  for (const argv of [
    ['--redis-witness-network', 'unit'],
    ['--engine-host', 'unix:///qa.sock', '--redis-witness-network', 'unit'],
    ['--engine-host', 'unix:///qa.sock', '--clock-calibration', '--redis-witness-network', 'a/b'],
  ]) assert.throws(() => observationOptions(argv, {}), /requires clock calibration/)
  for (const overrides of [{ redisWitnessTarget: null }, { verifyWitnessIdentity: null },
    { redisWitnessTarget: { ...target, networkName: 'other' } }]) {
    assert.throws(() => startObservation({ ...options(), ...overrides }), /verified Engine target/)
  }
})

test('standalone: witness-only refusal keeps the clock admission true and acquires no pause or cleanup', async () => {
  for (const mode of ['refused', 'constructor-throws', 'admission-throws']) {
  const opts = { ...options(), beforeMs: 300, pauseMs: 0, recoverMs: 0, out: 'memory' }
  const commands = [], events = []
  let written
  await assert.rejects(runStandaloneObservation(opts, {
    docker: async (command, _flag, format, name) => {
      commands.push(command)
      return format === '{{.Id}}' ? (name === 'unit-a' ? 'a' : 'b').repeat(64) : 'false'
    },
    createPauseTransport: async () => ({ evidence: { engineContainerId: target.containerId }, witnessTarget: target,
      verifyWitnessIdentity: opts.verifyWitnessIdentity, readClock: opts.readEngineClock,
      change: async operation => { commands.push(operation); assert.fail('no injection may be acquired') },
    }),
    startObservation: actual => startObservation(actual, {
      fetch, monotonicNow: Date.now, logsSince: log, writeReport: (_path, report) => { written = report },
      startRedisFreezeWitness: () => {
        if (mode === 'constructor-throws') throw new Error('controlled constructor failure')
        return {
        admissionBeforePause: () => {
          if (mode === 'admission-throws') throw new Error('controlled admission failure')
          return { valid: false, issues: ['controlled missing Redis echo'] }
        },
        pauseAttempted: () => { events.push('attempted'); assert.fail('a refused witness cannot attempt a pause') },
        stop: async () => { events.push('stopped'); return null },
      } },
    }),
  }), /pause admission refused/)
  assert.equal(written.summary.baseline.valid, true)
  assert.equal(written.summary.pauseAdmission.valid, false)
  assert.equal(written.summary.pauseAdmission.clockValid, true)
  assert.equal(written.summary.pauseAdmission.witnessValid, false)
  assert.ok(written.summary.pauseAdmission.issues.includes(mode === 'refused' ? 'controlled missing Redis echo'
    : mode === 'constructor-throws' ? 'Redis witness construction failed' : 'Redis witness admission failed'))
  for (const key of ['pauseStartedAtMs', 'pausedAtMs', 'unpauseStartedAtMs', 'unpausedAtMs']) assert.equal(written.summary[key], null)
  assert.deepEqual(commands.filter(command => command === 'pause' || command === 'unpause'), [])
  assert.deepEqual(events, mode === 'constructor-throws' ? [] : ['stopped'])
  assert.equal(written.summary.measurementValid, false)
  }
})

test('observer awaits the witness close promise before final identity, logs and serialization, and shares stop', async () => {
  let releaseClose, settled = false, stoppedCalls = 0
  const close = new Promise(resolve => { releaseClose = resolve })
  const events = []
  const observer = startObservation({ ...options(), out: 'memory', verifyWitnessIdentity: async () => {
    events.push('identity'); return { valid: true }
  } }, { fetch, monotonicNow: Date.now,
    logsSince: cell => { events.push('logs'); return log(cell) },
    writeReport: () => { events.push('write') },
    startRedisFreezeWitness: () => ({ stop: () => { stoppedCalls += 1; events.push('stop'); return close } }),
  })
  try {
    const stopped = observer.stop()
    assert.equal(observer.stop(), stopped, 'stop must return its original promise')
    void stopped.then(() => { settled = true })
    await sleep(30)
    assert.equal(settled, false)
    assert.deepEqual(events, ['stop'], 'no identity/log/report work may hide an unawaited socket cleanup')
    releaseClose(null)
    const report = await stopped
    assert.deepEqual(events, ['stop', 'identity', 'logs', 'logs', 'write'])
    assert.equal(stoppedCalls, 1)
    assert.equal(report.summary.freezeWitness.valid, false, 'missing witness data cannot fall back to success')
  } finally { releaseClose(null); await observer.stop() }
})

test('standalone seals before release even with uncertain ACK or throwing unpause telemetry', async () => {
  for (const uncertainAck of [false, true]) {
    const events = []
    let paused = false, stoppedWith
    await assert.rejects(runStandaloneObservation({ ...options(), beforeMs: 0, pauseMs: 0, recoverMs: 0 }, {
      docker: async (_command, _flag, format, name) => format === '{{.Id}}'
        ? (name === 'unit-a' ? 'a' : 'b').repeat(64) : String(paused),
      createPauseTransport: async () => ({ evidence: { engineContainerId: target.containerId },
        change: async operation => {
          events.push(operation)
          paused = operation === 'pause'
          if (uncertainAck && paused) throw new Error('uncertain pause ACK')
        },
      }),
      startObservation: () => ({
        pauseStarted() {}, pauseCompleted: () => { events.push('ack') },
        sealBeforeUnpause: () => { events.push('sealed'); if (!uncertainAck) throw new Error('cutoff clock failed') },
        unpauseStarted: () => { events.push('resume-mark'); throw new Error('unpause clock failed') },
        stop: async value => { stoppedWith = value; return {} },
      }),
    }))
    assert.equal(paused, false)
    assert.deepEqual(events, uncertainAck ? ['pause', 'sealed', 'unpause'] : ['pause', 'ack', 'sealed', 'resume-mark', 'unpause'])
    assert.ok(stoppedWith.error)
  }
})

test('witness stamps inherit both original collector origins and the ACK stops emissions before a bad clock', async () => {
  let wall = 1000, mono = 40_000, throwClock = false
  const stamps = [], events = []
  const observer = startObservation(options(), { fetch, logsSince: log,
    now: () => { if (throwClock) throw new Error('clock unavailable'); return wall },
    monotonicNow: () => mono,
    startRedisFreezeWitness: ({ clock }) => {
      stamps.push(clock())
      return {
        pauseAcknowledged: () => { events.push('ack'); stamps.push(clock()) },
        sealBeforeUnpause: () => { events.push('sealed'); stamps.push(clock()) },
        stop: async () => null,
      }
    },
  })
  wall += 7; mono += 7
  observer.sealBeforeUnpause()
  assert.deepEqual(stamps, [{ at: 0, monoAt: 0, ordinal: 1 }, { at: 7, monoAt: 7, ordinal: 2 }])
  throwClock = true
  assert.throws(() => observer.pauseCompleted(), /clock unavailable/)
  assert.deepEqual(events, ['sealed', 'ack'])
  throwClock = false
  await observer.stop()
})
