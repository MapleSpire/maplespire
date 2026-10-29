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
import { EventEmitter } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { startRedisFreezeWitness, analyzeRedisFreezeWitness, REDIS_FREEZE_WITNESS_LIMITS } from './sync-cell-redis-pause-witness.mjs'

const target = {
  containerId: 'a'.repeat(64), ip: '127.0.0.1', port: 6379, networkName: 'witness-test_default',
  networkId: 'b'.repeat(64), project: 'witness-test', service: 'redis', imageId: `sha256:${'c'.repeat(64)}`,
  startedAt: '2026-09-06T00:00:00.000000000Z', restartCount: 0,
}
const clone = (value) => JSON.parse(JSON.stringify(value))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const response = (command) => {
  const parts = command.toString('ascii').split('\r\n')
  assert.deepEqual(parts.slice(0, 4), ['*2', '$4', 'PING', '$42'])
  assert.match(parts[4], /^g1b3:[a-f0-9]{32}:\d{4}$/)
  assert.equal(parts[5], '')
  assert.equal(parts.length, 6)
  return Buffer.from(`$42\r\n${parts[4]}\r\n`)
}

// Admission refuses a reply older than 50 ms, correctly, and a starved loop
// resumes a test's sleep before the poll phase can deliver the next reply, so
// admitting right after a sleep measured the host (2026-10-25: red under load
// with the witness truthfully reporting admission-stale). `next()` resolves when
// the client has received a whole number of 49-byte replies; its continuation
// runs after the entire 'data' emit, the witness's own listener included, so
// the reply it waited for is matched and fresh at the admission call.
function replyTap() {
  let received = 0, waiter = null
  return {
    connect: (options) => {
      const socket = createConnection(options)
      socket.on('data', (chunk) => {
        received += chunk.length
        if (received % 49 === 0 && waiter) { const resolve = waiter; waiter = null; resolve() }
      })
      return socket
    },
    next: () => new Promise((resolve) => { waiter = resolve }),
  }
}

function harness(options = {}) {
  const time = { now: options.now ?? 10, ordinal: 0, wallOffset: 0, fail: false, stepAfterRead: 0 }
  let timerId = 0
  const timers = new Map()
  const add = (callback, ms, interval) => {
    const id = ++timerId
    timers.set(id, { callback, at: time.now + ms, period: interval ? ms : null })
    return id
  }
  const advance = (ms, runTimers = true) => {
    const until = time.now + ms
    if (runTimers) {
      let iterations = 0
      while (true) {
        const next = [...timers].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        assert.ok(++iterations < 10000, 'bounded manual timers')
        time.now = Math.max(time.now, next[1].at)
        if (next[1].period) next[1].at += next[1].period
        else timers.delete(next[0])
        next[1].callback()
      }
    }
    time.now = until
  }
  const socket = new EventEmitter()
  Object.assign(socket, {
    remoteAddress: options.remoteAddress ?? target.ip, remotePort: options.remotePort ?? target.port,
    destroyed: false, writes: [], destroyCalls: 0,
    setNoDelay(value) { assert.equal(value, true); if (options.configureThrows) throw new Error('private socket option failure') },
    write(buffer) {
      if (options.writeThrows) throw new Error('secret write failure')
      this.writes.push(Buffer.from(buffer))
      return !options.writeBuffered
    },
    destroy() {
      this.destroyCalls++
      if (this.destroyed) return
      this.destroyed = true
      if (!options.holdClose) queueMicrotask(() => this.emit('close'))
    },
  })
  let connections = 0
  const clock = () => {
    if (time.fail) throw new Error('private clock payload')
    const value = { at: time.now + time.wallOffset, monoAt: time.now, ordinal: ++time.ordinal }
    time.now += time.stepAfterRead
    return value
  }
  const witness = startRedisFreezeWitness({ target: options.target ?? target, clock, limits: options.limits }, {
    connect(args) {
      connections++
      assert.deepEqual(args, { host: target.ip, port: target.port, family: 4 })
      if (options.connectThrows) throw new Error('private endpoint data')
      return socket
    },
    randomBytes: () => Buffer.alloc(16, 7),
    setTimeout: (callback, ms) => add(callback, ms, false), clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, ms) => add(callback, ms, true), clearInterval: (id) => timers.delete(id),
  })
  const reply = (bytes = response(socket.writes.at(-1))) => socket.emit('data', bytes)
  const ready = () => {
    socket.emit('connect')
    reply()
    advance(5)
    reply()
  }
  return { witness, time, timers, socket, advance, reply, ready, get connections() { return connections } }
}

// The two real-TCP tests run on the wall clock, so their deadlines measure the
// scheduler too: on a starved CI runner the process went ~150 ms without
// running a timer (last reply at 304 ms, admission checked at 460 ms, no request
// in between), and the default 50 ms admission age refused it as stale —
// correctly. Staleness, timeouts and cleanup budgets are pinned with the manual
// clock above; these tests are about real bytes on a real socket, so they give
// every scheduling-dependent deadline room. The clock-model constants are not
// tunable and stay at their defaults.
const REAL_TCP_LIMITS = { maxAdmissionAgeMs: 1500, responseTimeoutMs: 1500, connectTimeoutMs: 1500, closeTimeoutMs: 1500 }

async function goodArtifact() {
  const h = harness()
  h.ready()
  assert.equal(h.witness.admissionBeforePause().valid, true)
  h.witness.pauseAttempted() // original shared time 15
  h.advance(5) // request 3 at 20
  h.witness.pauseAcknowledged()
  h.advance(2)
  h.reply() // buffered response after ACK
  h.advance(5)
  h.witness.sealBeforeUnpause()
  h.advance(1)
  const report = await h.witness.stop()
  assert.equal(report.instrumentValid, true, JSON.stringify(report.issues))
  return { h, report }
}

test('fixed clock model and default budgets are explicit', () => {
  assert.deepEqual(REDIS_FREEZE_WITNESS_LIMITS, {
    periodMs: 5, connectTimeoutMs: 500, responseTimeoutMs: 250, lifetimeMs: 3000,
    maxRequests: 1024, maxResponseBytes: 256, maxTxBytes: 131072, maxRxBytes: 131072,
    minAdmissionReplies: 2, maxAdmissionAgeMs: 50, closeTimeoutMs: 250,
    quantizationMs: 1, wallMonotonicToleranceMs: 2,
  })
  for (const limits of [{ quantizationMs: 0 }, { wallMonotonicToleranceMs: 3 }, { maxRequests: 1025 }, { minAdmissionReplies: 1 }]) {
    assert.throws(() => harness({ limits }), /Invalid Redis witness limits/)
  }
})

test('real TCP uses only complete PING nonces, filters target, and closes its socket', async (t) => {
  const sockets = new Set()
  const commands = []
  let connections = 0
  const server = createServer((socket) => {
    connections++
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 63) {
        const command = buffer.subarray(0, 63)
        buffer = buffer.subarray(63)
        commands.push(command)
        const bytes = response(command)
        socket.write(bytes.subarray(0, 4))
        setImmediate(() => { if (!socket.destroyed) socket.write(bytes.subarray(4)) })
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  const origin = performance.now()
  let ordinal = 0
  const replies = replyTap()
  const witness = startRedisFreezeWitness({
    target: { ...target, port: server.address().port, Config: { Env: ['SECRET=never retain'] } },
    clock: () => { const monoAt = performance.now() - origin; return { at: Math.floor(monoAt), monoAt, ordinal: ++ordinal } },
    limits: REAL_TCP_LIMITS,
  }, { connect: replies.connect })
  t.after(() => witness.stop())
  const deadline = performance.now() + 1500
  while (commands.length < 3 && performance.now() < deadline) await sleep(3)
  assert.ok(commands.length >= 3)
  await replies.next()
  // Do not repeatedly call the admission gate while waiting for enough samples.
  const admission = witness.admissionBeforePause()
  assert.equal(admission.valid, true, JSON.stringify(admission))
  witness.pauseAttempted()
  witness.pauseAcknowledged()
  await sleep(5)
  witness.sealBeforeUnpause()
  const stopped = witness.stop()
  assert.equal(stopped, witness.stop())
  const report = await stopped
  assert.equal(report.instrumentValid, true, JSON.stringify(report.issues))
  assert.equal(connections, 1)
  assert.equal(new Set(commands.map((item) => item.toString())).size, commands.length)
  assert.equal(report.cleanup.cleanupConfirmed, true)
  assert.equal(report.cleanup.socketClosed, true)
  assert.equal(report.cleanup.activeTimers, 0)
  assert.equal(JSON.stringify(report).includes('SECRET'), false)
})

test('real TCP stays healthy for the full two-second baseline and stops normally with null', async (t) => {
  const sockets = new Set()
  let count = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on('data', (bytes) => {
      buffer = Buffer.concat([buffer, bytes])
      while (buffer.length >= 63) {
        count++
        socket.write(response(buffer.subarray(0, 63)))
        buffer = buffer.subarray(63)
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  })
  const origin = performance.now()
  let ordinal = 0
  const replies = replyTap()
  const witness = startRedisFreezeWitness({ target: { ...target, port: server.address().port },
    clock: () => { const monoAt = performance.now() - origin; return { at: Math.floor(monoAt), monoAt, ordinal: ++ordinal } },
    limits: REAL_TCP_LIMITS },
  { connect: replies.connect })
  t.after(() => witness.stop())
  await sleep(2000)
  assert.ok(count >= 2)
  await replies.next()
  const admission = witness.admissionBeforePause()
  assert.equal(admission.valid, true, JSON.stringify(admission))
  witness.pauseAttempted()
  witness.pauseAcknowledged()
  await sleep(10)
  witness.sealBeforeUnpause()
  const report = await witness.stop(null)
  assert.equal(report.instrumentValid, true, JSON.stringify(report.issues))
  assert.equal(report.cleanup.cleanupConfirmed, true)
  assert.equal(report.counts.connections, 1)
  assert.equal(report.records.length, count)
})

test('a complete post-ACK reply qualifies its original departure, not its arrival', async () => {
  const { report, h } = await goodArtifact()
  assert.deepEqual(report.qualifiedRecordIds, [1, 2, 3])
  assert.equal(report.pauseLowerMs, 19)
  assert.equal(report.gainMs, 4)
  assert.equal(report.records[2].responseAt.at, 22)
  assert.equal(report.records[2].requestedAt.at, 20)
  assert.equal(h.connections, 1)
  assert.equal(h.timers.size, 0)
  assert.deepEqual(analyzeRedisFreezeWitness(report), {
    instrumentValid: true, issues: [], qualifiedRecordIds: [1, 2, 3], pauseLowerMs: 19, gainMs: 4,
  })
})

test('buffered writes are never retransmitted and each fragment must match', async () => {
  const h = harness({ writeBuffered: true })
  h.ready()
  h.witness.pauseAttempted()
  h.advance(5)
  const bytes = response(h.socket.writes.at(-1))
  h.witness.pauseAcknowledged()
  h.advance(1)
  for (let index = 0; index < bytes.length; index++) h.reply(bytes.subarray(index, index + 1))
  h.socket.emit('drain')
  h.advance(5)
  h.witness.sealBeforeUnpause()
  const report = await h.witness.stop()
  assert.equal(report.instrumentValid, true, JSON.stringify(report.issues))
  assert.equal(h.socket.writes.length, 3)
  assert.equal(report.records.every((record) => record.writeBuffered), true)
  assert.equal(report.records[2].receivedBytes, bytes.length)
})

test('admission refuses zero samples immediately and remains refused', async () => {
  const h = harness()
  assert.equal(h.witness.admissionBeforePause().valid, false)
  h.ready()
  assert.equal(h.witness.admissionBeforePause().valid, false)
  assert.throws(() => h.witness.pauseAttempted(), /admission refused/)
  const report = await h.witness.stop()
  assert.equal(report.marks.pauseAttempted, null)
  assert.equal(report.instrumentValid, false)
})

test('admission checks departure freshness as well as arrival freshness', async () => {
  const h = harness()
  h.socket.emit('connect'); h.reply(); h.advance(5)
  h.advance(60); h.reply()
  const admission = h.witness.admissionBeforePause()
  assert.equal(admission.valid, false)
  assert.ok(admission.issues.includes('admission-stale'))
  await h.witness.stop()
})

test('admission checks an expired pending even if its timer has not fired', async () => {
  const h = harness({ limits: { maxAdmissionAgeMs: 1000 } })
  h.ready(); h.advance(5); h.advance(250, false)
  assert.ok(h.witness.admissionBeforePause().issues.includes('admission-pending-expired'))
  await h.witness.stop()
})

test('one command remains in flight and ACK prevents all subsequent writes', async () => {
  const h = harness()
  h.ready(); h.witness.pauseAttempted(); h.advance(5); h.advance(20)
  assert.equal(h.socket.writes.length, 3)
  h.witness.pauseAcknowledged(); h.reply(); h.advance(100)
  assert.equal(h.socket.writes.length, 3)
  h.witness.sealBeforeUnpause()
  const report = await h.witness.stop()
  assert.ok(report.counts.skippedBusy >= 4)
  assert.equal(report.instrumentValid, true)
})

test('a pending timeout after attempted pause is expected, but gives no new witness', async () => {
  const h = harness()
  h.ready(); h.witness.pauseAttempted(); h.advance(5); h.witness.pauseAcknowledged(); h.advance(250)
  await Promise.resolve()
  h.witness.sealBeforeUnpause()
  const report = await h.witness.stop()
  assert.equal(report.instrumentValid, true, JSON.stringify(report.issues))
  assert.equal(report.records[2].outcome, 'timeout')
  assert.deepEqual(report.qualifiedRecordIds, [1, 2])
  assert.equal(report.gainMs, 0)
  assert.equal(report.pauseLowerMs, 14)
})

test('response deadline includes the last CRLF, does not slide on fragments, and beats a delayed timer', async () => {
  const h = harness()
  h.ready(); h.witness.pauseAttempted(); h.advance(5); h.witness.pauseAcknowledged()
  const bytes = response(h.socket.writes.at(-1))
  h.advance(249, false); h.reply(bytes.subarray(0, bytes.length - 1))
  h.advance(1, false); h.reply(bytes.subarray(-1))
  h.advance(5, false); h.witness.sealBeforeUnpause()
  const report = await h.witness.stop()
  assert.equal(report.records[2].outcome, 'timeout')
  assert.equal(report.records[2].responseAt, null)
  assert.deepEqual(report.qualifiedRecordIds, [1, 2])
})

test('timeout before pause is an instrument failure and cannot admit', async () => {
  const h = harness()
  h.socket.emit('connect'); h.advance(250)
  assert.equal(h.witness.admissionBeforePause().valid, false)
  const report = await h.witness.stop()
  assert.ok(report.issues.includes('response-timeout-before-pause'))
})

test('connect deadline is also checked in the connect callback', async () => {
  const h = harness()
  h.advance(500, false); h.socket.emit('connect')
  assert.equal(h.socket.writes.length, 0)
  const report = await h.witness.stop()
  assert.ok(report.issues.includes('connect-timeout'))
})

test('late ACK is invalid even when its lifetime timer callback has been retained', async () => {
  const h = harness()
  h.ready()
  h.witness.pauseAttempted()
  h.advance(3000, false)
  h.witness.pauseAcknowledged()
  h.advance(1, false)
  h.witness.sealBeforeUnpause()
  const report = await h.witness.stop(null)
  assert.equal(report.cleanup.cleanupConfirmed, true)
  assert.equal(report.instrumentValid, false)
  assert.ok(report.issues.includes('pause-ack-deadline-exceeded'))
  assert.equal(report.pauseLowerMs, null)
})

test('ACK at exactly 3000 ms is invalid and still permits seal and complete cleanup', async () => {
  const h = harness()
  h.ready(); h.witness.pauseAttempted()
  h.advance(3000 - h.time.now, false)
  assert.doesNotThrow(() => h.witness.pauseAcknowledged())
  h.advance(1, false)
  assert.doesNotThrow(() => h.witness.sealBeforeUnpause())
  const report = await h.witness.stop(null)
  assert.equal(report.marks.pauseAcknowledged.monoAt, 3000)
  assert.ok(report.issues.includes('pause-ack-deadline-exceeded'))
  assert.equal(report.instrumentValid, false)
  assert.equal(report.cleanup.cleanupConfirmed, true)
})

test('pause attempt stamp crossing 3000 ms after valid admission refuses before the POST', async () => {
  const h = harness({ now: 2990 })
  h.ready()
  h.advance(4, false) // newest complete request 2995, admission clock 2999
  h.time.stepAfterRead = 1 // following attempted-pause stamp is exactly 3000
  let postCalls = 0
  assert.throws(() => { h.witness.pauseAttempted(); postCalls++ }, /exceeds lifetime/)
  h.time.stepAfterRead = 0
  assert.equal(postCalls, 0)
  assert.equal(h.witness.admissionBeforePause().valid, false)
  assert.doesNotThrow(() => h.witness.sealBeforeUnpause())
  const report = await h.witness.stop(null)
  assert.equal(report.marks.pauseAttempted, null)
  assert.equal(report.stamps.find((entry) => entry.kind === 'pause-attempted').stamp.monoAt, 3000)
  assert.ok(report.issues.includes('pause-attempt-deadline-exceeded'))
  assert.equal(report.instrumentValid, false)
  assert.equal(report.cleanup.cleanupConfirmed, true)
})

test('pure reducer independently rejects raw late attempt and ACK without a transport fault', async () => {
  const h = harness()
  h.ready(); h.witness.pauseAttempted(); h.witness.pauseAcknowledged()
  h.advance(5, false); h.witness.sealBeforeUnpause()
  const original = await h.witness.stop(null)
  assert.equal(original.instrumentValid, true)
  for (const [phase, issue] of [['pauseAttempted', 'pause-attempt-deadline-exceeded'],
    ['pauseAcknowledged', 'pause-ack-deadline-exceeded']]) {
    const report = clone(original)
    const ordinal = report.marks[phase].ordinal
    const delta = 3000 - report.marks[phase].monoAt
    const shift = (value) => {
      if (!value || typeof value !== 'object') return
      if (typeof value.ordinal === 'number' && value.ordinal >= ordinal) {
        value.at += delta; value.monoAt += delta
      } else for (const child of Object.values(value)) shift(child)
    }
    shift(report)
    assert.deepEqual(report.transportIssues, [])
    const result = analyzeRedisFreezeWitness(report)
    assert.equal(result.instrumentValid, false)
    assert.ok(result.issues.includes(issue), JSON.stringify(result.issues))
    assert.equal(result.pauseLowerMs, null)
  }
})

test('an early deadline callback rearms the remaining absolute time', async () => {
  const h = harness()
  const [id, timer] = [...h.timers].find(([, value]) => value.at === 510)
  h.timers.delete(id)
  h.advance(499, false)
  timer.callback()
  assert.equal(h.socket.destroyed, false)
  assert.ok([...h.timers.values()].some((value) => value.at === 510))
  h.advance(1)
  const report = await h.witness.stop()
  assert.ok(report.issues.includes('connect-timeout'))
})

test('lifetime is relative to observation origin, never a fresh witness origin', async () => {
  const h = harness({ now: 2990 })
  h.socket.emit('connect'); h.reply(); h.advance(10)
  const report = await h.witness.stop()
  assert.ok(report.issues.includes('lifetime-exhausted-before-ack'))
  assert.ok(report.createdAt.monoAt === 2990)
  assert.equal(h.timers.size, 0)
})

test('response completely handled after seal cannot improve the lower bound', async () => {
  const h = harness()
  h.ready(); h.witness.pauseAttempted(); h.advance(5); h.witness.pauseAcknowledged()
  const bytes = response(h.socket.writes.at(-1))
  h.reply(bytes.subarray(0, bytes.length - 1))
  h.advance(2); h.witness.sealBeforeUnpause(); h.advance(2); h.reply(bytes.subarray(-1))
  const report = await h.witness.stop()
  assert.equal(report.instrumentValid, true)
  assert.equal(report.records[2].admittedBeforeSeal, false)
  assert.deepEqual(report.qualifiedRecordIds, [1, 2])
  assert.equal(report.gainMs, 0)
})

test('same-millisecond response and seal are conservatively excluded', async () => {
  const h = harness()
  h.ready(); h.witness.pauseAttempted(); h.advance(5); h.witness.pauseAcknowledged(); h.reply()
  h.witness.sealBeforeUnpause()
  const report = await h.witness.stop()
  assert.deepEqual(report.qualifiedRecordIds, [1, 2])
})

for (const [name, make] of [
  ['plain PONG', () => Buffer.from('+PONG\r\n')],
  ['Redis error', () => Buffer.from('-NOAUTH private-secret\r\n')],
  ['wrong nonce', (bytes) => { const result = Buffer.from(bytes); result[10] ^= 1; return result }],
  ['wrong length', (bytes) => Buffer.concat([Buffer.from('$43'), bytes.subarray(3)])],
  ['extra full response', (bytes) => Buffer.concat([bytes, bytes])],
  ['oversized payload', () => Buffer.alloc(257, 65)],
]) {
  test(`strict RESP rejects ${name} and never retains raw payload`, async () => {
    const h = harness()
    h.ready(); h.witness.pauseAttempted(); h.advance(5); h.witness.pauseAcknowledged()
    h.reply(make(response(h.socket.writes.at(-1))))
    h.advance(5); h.witness.sealBeforeUnpause()
    const report = await h.witness.stop()
    assert.equal(report.instrumentValid, false)
    assert.deepEqual(report.qualifiedRecordIds, [])
    assert.equal(report.pauseLowerMs, null)
    assert.ok(report.issues.includes('response-framing-invalid'))
    assert.equal(JSON.stringify(report).includes('private-secret'), false)
  })
}

test('an extra response in a later chunk invalidates earlier completed candidates', async () => {
  const h = harness()
  h.ready(); h.witness.pauseAttempted(); h.advance(5); h.witness.pauseAcknowledged(); h.reply()
  h.advance(1); h.reply(response(h.socket.writes.at(-1)))
  h.advance(5); h.witness.sealBeforeUnpause()
  const report = await h.witness.stop()
  assert.ok(report.issues.includes('unsolicited-response'))
  assert.equal(report.instrumentValid, false)
  assert.equal(report.pauseLowerMs, null)
})

test('remote endpoint mismatch sends no PING and never reconnects', async () => {
  const h = harness({ remoteAddress: '127.0.0.2' })
  h.socket.emit('connect')
  const report = await h.witness.stop()
  assert.equal(h.connections, 1)
  assert.equal(h.socket.writes.length, 0)
  assert.ok(report.issues.includes('remote-endpoint-mismatch'))
})

test('invalid targets and credentials never reach connect', () => {
  for (const invalid of [{ ...target, ip: 'redis' }, { ...target, service: 'redis-render-cache' },
    { ...target, containerId: 'abcd' }, { ...target, port: 0 }]) {
    assert.throws(() => harness({ target: invalid }), /Invalid Redis witness target/)
  }
})

test('synchronous socket failures are bounded, recorded, and sanitized', async () => {
  for (const options of [{ connectThrows: true }, { writeThrows: true }, { configureThrows: true }]) {
    const h = harness(options)
    if (!options.connectThrows) h.socket.emit('connect')
    const report = await h.witness.stop()
    assert.equal(report.instrumentValid, false)
    assert.equal(report.cleanup.cleanupConfirmed, true)
    assert.equal(JSON.stringify(report).includes('private'), false)
    assert.equal(JSON.stringify(report).includes('secret'), false)
  }
})

test('seal latches despite a throwing clock; stop and socket cleanup still run', async () => {
  const h = harness()
  h.ready(); h.witness.pauseAttempted(); h.advance(5); h.witness.pauseAcknowledged()
  h.time.fail = true
  assert.doesNotThrow(() => h.witness.sealBeforeUnpause())
  h.time.fail = false
  h.reply()
  const report = await h.witness.stop()
  assert.equal(report.records[2].admittedBeforeSeal, false)
  assert.equal(report.instrumentValid, false)
  assert.equal(report.cleanup.cleanupConfirmed, true)
  assert.ok(report.issues.includes('clock-read-failed'))
})

test('wall/monotonic disagreement on a data event invalidates the whole instrument', async () => {
  const h = harness()
  h.ready(); h.witness.pauseAttempted(); h.advance(5); h.witness.pauseAcknowledged()
  h.time.wallOffset = 3; h.reply(); h.time.wallOffset = 0
  h.advance(5); h.witness.sealBeforeUnpause()
  const report = await h.witness.stop()
  assert.equal(report.instrumentValid, false)
  assert.ok(report.issues.includes('wall-monotonic-disagreement'))
})

test('stop is the same promise and waits actual close, clearing every owned timer', async () => {
  const h = harness({ holdClose: true })
  h.ready(); h.witness.pauseAttempted(); h.witness.pauseAcknowledged(); h.advance(5); h.witness.sealBeforeUnpause()
  let settled = false
  const first = h.witness.stop()
  first.then(() => { settled = true })
  assert.equal(first, h.witness.stop('later reason'))
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(h.timers.size, 1) // only the close deadline, no sampling/work timers
  h.socket.emit('error', new Error('late private payload'))
  h.socket.emit('close')
  const report = await first
  assert.equal(report.cleanup.cleanupConfirmed, true)
  assert.equal(h.timers.size, 0)
  assert.equal(report.instrumentValid, false) // asynchronous socket error is not hidden
})

test('missing close resolves invalid at its explicit deadline, never claiming cleanup', async () => {
  const h = harness({ holdClose: true })
  h.ready(); h.witness.pauseAttempted(); h.witness.pauseAcknowledged(); h.advance(5); h.witness.sealBeforeUnpause()
  const stopped = h.witness.stop()
  h.advance(250)
  const report = await stopped
  assert.equal(report.instrumentValid, false)
  assert.equal(report.cleanup.cleanupConfirmed, false)
  assert.equal(report.cleanup.closeTimedOut, true)
  assert.equal(report.cleanup.activeTimers, 0)
  assert.ok(report.issues.includes('socket-close-timeout'))
})

test('pure reducer rejects forged success, missing clocks, ACK ordering and false cleanup', async () => {
  const { report } = await goodArtifact()
  for (const change of [
    (value) => { value.cleanup.cleanupConfirmed = false },
    (value) => { value.admission.completedReplies = 999; value.records.splice(0, 2) },
    (value) => { value.stamps = value.stamps.filter((entry) => entry.stamp.ordinal !== value.records[2].responseAt.ordinal) },
    (value) => { value.marks.pauseAcknowledged = value.records[1].responseAt },
    (value) => { value.records[2].receivedBytes-- },
    (value) => { value.records[2].nonce = value.records[1].nonce },
    (value) => { delete value.counts.txBytes },
    (value) => { value.counts.rxBytes = NaN },
    (value) => { value.records[2].outcome = 'assumed-success' },
    (value) => { value.cleanup.socketCreated = false },
    (value) => { value.records[2].requestedAt = value.connectedAt },
    (value) => { value.records[2].receivedBytes = -1 },
    (value) => { value.records.push({ ...value.records[2], id: 4 }) },
    (value) => {
      value.marks.pauseAcknowledged = value.records[1].responseAt
      value.records[2].outcome = 'cancelled'
      value.records[2].responseAt = null
      value.records[2].admittedBeforeSeal = false
    },
  ]) {
    const changed = clone(report)
    change(changed)
    const result = analyzeRedisFreezeWitness(changed)
    assert.equal(result.instrumentValid, false, JSON.stringify(result))
    assert.equal(result.pauseLowerMs, null)
    assert.deepEqual(result.qualifiedRecordIds, [])
  }
  for (const invalid of [null, {}, { ...report, stamps: [null] }, { ...report, records: [null] }]) {
    assert.equal(analyzeRedisFreezeWitness(invalid).instrumentValid, false)
  }
})
