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
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { captureDedicatedNative } from './sync-cell-dedicated-native.mjs'
import { createDedicatedOperations, requestDedicatedJson } from './sync-cell-dedicated-runtime.mjs'

async function waitFor(action, milliseconds = 3_000) {
  const start = performance.now()
  for (;;) {
    const value = await action()
    if (value) return value
    assert.ok(performance.now() - start < milliseconds, 'Fixture did not reach its cleanup witness')
    await delay(20)
  }
}

test('native healthy control observes the real child close and captures its output', async () => {
  const result = await captureDedicatedNative(process.execPath, ['-e', 'console.log("native-healthy-control")'], { timeoutMs: 3_000 })
  assert.equal(result.receipt.code, 0)
  assert.equal(result.receipt.signal, null)
  assert.equal(result.receipt.closed, true)
  assert.equal(result.receipt.rootExited, true)
  assert.equal(result.receipt.cleanupConfirmed, true)
  assert.equal(result.receipt.captureDetached, false)
  assert.match(result.stdout, /native-healthy-control/)
})

for (const holdClose of [false, true]) {
test(holdClose ? 'hybrid: real exited parent with close delivery held returns a bounded unconfirmed receipt'
  : 'real exited parent with a detached descendant retaining stdout returns a bounded unconfirmed receipt', { timeout: 12_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maplespire-dedicated-native-'))
  const ready = join(directory, 'ready.json'), stop = join(directory, 'stop'), done = join(directory, 'done.json')
  let pid, releaseClose, nativeCloseDelivered = false, nativeExitDelivered = false
  // The fixture models ordinary node/npm processes, not nested test workers.
  // The descendant inherits this same environment from its parent.
  const fixtureEnv = { ...process.env }
  delete fixtureEnv.NODE_TEST_CONTEXT
  delete fixtureEnv.NODE_OPTIONS
  const spawnProcess = (...args) => {
    const child = spawn(...args)
    child.once('close', () => { nativeCloseDelivered = true })
    child.once('exit', () => { nativeExitDelivered = true })
    if (holdClose) {
      const emit = child.emit
      child.emit = function(event, ...payload) {
        if (event !== 'close') return emit.call(this, event, ...payload)
        releaseClose = () => emit.call(this, event, ...payload)
        return true
      }
    }
    return child
  }
  const descendant = `
    const fs = require('node:fs');
    const [ready, stop, done] = process.argv.slice(1);
    process.stdout.on('error', () => {});
    fs.writeFileSync(ready, JSON.stringify({ pid: process.pid }));
    process.stdout.write('DESCENDANT_HOLDS_STDOUT\\n');
    const timer = setInterval(() => {
      if (!fs.existsSync(stop)) return;
      clearInterval(timer);
      fs.writeFileSync(done, JSON.stringify({ pid: process.pid, requested: true }));
      process.exit(0);
    }, 25);
    setTimeout(() => process.exit(2), 10000).unref();
    process.send('ready');
  `
  const parent = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, ...process.argv.slice(1)],
      { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true, detached: true });
    child.once('error', error => { console.error(error.code); process.exitCode = 1; });
    child.once('message', () => { child.disconnect(); child.unref(); process.exit(0); });
  `
  try {
    const startedAt = performance.now()
    const result = await captureDedicatedNative(process.execPath, ['-e', parent, ready, stop, done],
      { timeoutMs: 1_200, joinTimeoutMs: 150, killTimeoutMs: 150, spawnProcess, env: fixtureEnv })
    assert.equal(result.receipt.closed, nativeCloseDelivered, 'closed reflects an event delivered by the actual ChildProcess')
    assert.equal(result.receipt.rootExited, nativeExitDelivered)
    assert.ok(performance.now() - startedAt < 3_500, 'An unjoinable inherited pipe must not wait for the descendant lifetime')
    const identity = JSON.parse(await readFile(ready, 'utf8'))
    pid = identity.pid
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    assert.equal(result.receipt.rootExited, true)
    assert.equal(result.receipt.cleanupScope, 'Direct child close and captured pipes only; no descendant census.')
    assert.equal(result.receipt.timedOut, true)
    assert.equal(result.receipt.cleanupConfirmed, false)
    assert.equal(result.receipt.captureDetached, true)
    assert.ok(result.receipt.cleanupIssues.includes('root-exited-before-pipe-close'))
    assert.ok(result.receipt.cleanupIssues.includes('native-close-deadline'))
    assert.equal(result.receipt.treeKill, undefined, 'Never send taskkill to the departed parent PID')
    assert.match(result.stdout, /DESCENDANT_HOLDS_STDOUT/, 'The real descendant must have inherited the measured pipe')
    assert.equal(result.stderr, '', 'The descendant must not exit from a fixture exception')
    process.kill(pid, 0)
    await writeFile(stop, 'stop\n')
    const ended = await waitFor(async () => {
      try { return JSON.parse(await readFile(done, 'utf8')) } catch { return false }
    })
    assert.deepEqual(ended, { pid, requested: true })
    await waitFor(() => { try { process.kill(pid, 0); return false } catch (error) { assert.equal(error.code, 'ESRCH'); return true } })
    releaseClose?.()
    assert.equal(result.receipt.cleanupConfirmed, false, 'Later cleanup by the test cannot rewrite the earlier receipt')
    console.log(JSON.stringify({ event: 'dedicated.native.orphan-control', platform: process.platform,
      closeDelivery: holdClose ? 'hybrid-delayed-event' : 'native', native: result.receipt, descendant: { pid, exited: true } }))
  } finally {
    await writeFile(stop, 'stop\n')
    if (!pid) {
      try { pid = JSON.parse(await readFile(ready, 'utf8')).pid } catch { /* spawn may have failed before any child existed */ }
    }
    if (pid) await waitFor(() => { try { process.kill(pid, 0); return false } catch (error) { assert.equal(error.code, 'ESRCH'); return true } }, 5_000)
    releaseClose?.()
    const resolved = await realpath(directory), root = await realpath(tmpdir())
    assert.ok(resolved.startsWith(root + sep) && basename(resolved).startsWith('maplespire-dedicated-native-'))
    await rm(resolved, { recursive: true })
  }
})
}

function fakeChild(pid) {
  const child = new EventEmitter()
  Object.assign(child, { pid, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(), unrefCalled: false,
    unref() { this.unrefCalled = true }, kill() { return false } })
  return child
}

for (const mode of ['failed', 'hanging']) {
  test(`a ${mode} taskkill cannot leave the native join pending indefinitely`, { timeout: 2_000 }, async () => {
    const child = fakeChild(12345), killer = fakeChild(12346)
    let calls = 0
    const spawnProcess = file => {
      calls++
      if (calls === 1) return child
      assert.equal(file, 'taskkill')
      if (mode === 'failed') queueMicrotask(() => killer.emit('close', 1, null))
      return killer
    }
    const startedAt = performance.now()
    const result = await captureDedicatedNative('fixture', [], { platform: 'win32', spawnProcess,
      timeoutMs: 20, killTimeoutMs: 40, joinTimeoutMs: 40 })
    assert.ok(performance.now() - startedAt < 750)
    assert.equal(result.receipt.cleanupConfirmed, false)
    assert.equal(result.receipt.closed, false)
    assert.equal(result.receipt.killError, true)
    assert.equal(result.receipt.captureDetached, true)
    assert.equal(child.unrefCalled, true)
    if (mode === 'hanging') {
      assert.equal(result.receipt.treeKill.timedOut, true)
      assert.equal(killer.unrefCalled, true)
    } else assert.equal(result.receipt.treeKill.code, 1)
  })
}

test('a failed cold-read cleanup stays sticky after its promise settles and later work succeeds', async () => {
  let resourcesClosed = 0
  const scope = createDedicatedOperations({ closeResources: async () => { resourcesClosed++ } })
  const coldFailure = new Error('cold read cleanup deadline')
  coldFailure.evidence = { complete: false, nativeResourcesClosed: false, reads: [{ cleanup: { confirmed: false } }] }
  await assert.rejects(scope.run(() => { throw coldFailure }))
  await scope.run(() => ({ complete: true, nativeResourcesClosed: true }))
  await assert.rejects(scope.close(), { code: 'DEDICATED_CLEANUP_UNCONFIRMED' })
  await assert.rejects(scope.close(), { code: 'DEDICATED_CLEANUP_UNCONFIRMED' })
  assert.equal(resourcesClosed, 1, 'Other cleanup still runs exactly once')
})

test('a returned native receipt with close observed but cleanup unconfirmed also poisons runtime closure', async () => {
  const scope = createDedicatedOperations()
  await scope.run(() => ({ native: { closed: true, cleanupConfirmed: false } }))
  await assert.rejects(scope.close(), { code: 'DEDICATED_CLEANUP_UNCONFIRMED' })
})

test('preflight cleanup obligations remain enforceable before an operation was registered', async () => {
  const scope = createDedicatedOperations()
  scope.mark({ evidence: { cleanupConfirmed: false } })
  await assert.rejects(scope.close(), { code: 'DEDICATED_CLEANUP_UNCONFIRMED' })
})

test('a failed three-cell reading envelope cannot hide its nested HTTP cleanup debt', async () => {
  const scope = createDedicatedOperations()
  const failure = new Error('cell requests failed')
  failure.evidence = { allRequestsJoined: true, readings: [
    { cellId: 'failover-cell-a', receipt: { cleanupConfirmed: true } },
    { cellId: 'failover-cell-b', receipt: { cleanupConfirmed: false } },
    { cellId: 'failover-cell-c', receipt: { cleanupConfirmed: true } },
  ] }
  await assert.rejects(scope.run(() => { throw failure }))
  await assert.rejects(scope.close(), { code: 'DEDICATED_CLEANUP_UNCONFIRMED' })
})

test('runtime close awaits active operations and then releases resources', async () => {
  let release, settled = false, resourcesClosed = false
  const held = new Promise(resolve => { release = resolve })
  const scope = createDedicatedOperations({ closeResources: async () => { resourcesClosed = true } })
  const operation = scope.run(() => held)
  const closing = scope.close().then(result => { settled = true; return result })
  await delay(20)
  assert.equal(settled, false); assert.equal(resourcesClosed, false)
  release({ nativeResourcesClosed: true })
  await operation
  assert.equal((await closing).cleanupConfirmed, true)
  assert.equal(resourcesClosed, true)
})

function heldHttpClose() {
  let notifyClosing, destroyCount = 0, released = false
  const closing = new Promise(resolve => { notifyClosing = resolve })
  const socket = new EventEmitter()
  socket.destroy = () => { destroyCount++; notifyClosing() }
  const closeOnce = resource => {
    let closed = false
    resource.destroy = () => { if (!closed) { closed = true; queueMicrotask(() => resource.emit('close')) } }
  }
  return {
    closing,
    get destroyCount() { return destroyCount },
    release() { if (!released) { released = true; socket.emit('close') } },
    requestImpl(_options, onResponse) {
      const request = new EventEmitter(), response = new EventEmitter()
      closeOnce(request); closeOnce(response)
      response.statusCode = 200; response.headers = {}
      request.end = () => queueMicrotask(() => {
        request.emit('socket', socket); onResponse(response)
        response.emit('data', Buffer.from('{"status":"ok"}')); response.emit('end')
      })
      return request
    },
  }
}

test('HTTP success waits for the actual close event, then preserves the request interval', async () => {
  const fixture = heldHttpClose()
  let settled = false
  const request = requestDedicatedJson(12345, '/api/health', { requestImpl: fixture.requestImpl })
    .then(result => { settled = true; return result })
  try {
    await fixture.closing; await delay(20)
    assert.equal(settled, false)
    fixture.release()
    const result = await request
    assert.equal(result.receipt.closed, true)
    assert.equal(result.receipt.cleanupConfirmed, true)
    assert.ok(result.receipt.completedAtMs >= result.receipt.startedAtMs)
    assert.deepEqual(result.value, { status: 'ok' })
  } finally { fixture.release(); await request.catch(() => undefined) }
})

test('an abort delivered while HTTP close is held remains armed and prevents success', async () => {
  const fixture = heldHttpClose(), controller = new AbortController()
  let settled = false
  const request = requestDedicatedJson(12345, '/api/health', { requestImpl: fixture.requestImpl, signal: controller.signal })
  void request.then(() => { settled = true }, () => { settled = true })
  try {
    await fixture.closing
    const before = fixture.destroyCount
    controller.abort()
    assert.ok(fixture.destroyCount > before, 'Abort must still invoke native-resource destruction during the close join')
    await delay(20); assert.equal(settled, false)
    fixture.release()
    await assert.rejects(request, error => {
      assert.equal(error.evidence.closed, true)
      assert.equal(error.evidence.cleanupConfirmed, true)
      assert.equal(error.evidence.aborted, true)
      return true
    })
  } finally { fixture.release(); await request.catch(() => undefined) }
})

test('the HTTP deadline remains armed through the close join', async () => {
  const fixture = heldHttpClose()
  const request = requestDedicatedJson(12345, '/api/health', { requestImpl: fixture.requestImpl, timeoutMs: 30 })
  void request.catch(() => undefined)
  try {
    await fixture.closing
    const before = fixture.destroyCount
    await delay(75)
    assert.ok(fixture.destroyCount > before)
    fixture.release()
    await assert.rejects(request, error => { assert.equal(error.evidence.timedOut, true); return true })
  } finally { fixture.release(); await request.catch(() => undefined) }
})

test('a missing HTTP close yields an unconfirmed obligation rather than a successful response', async () => {
  const fixture = heldHttpClose(), scope = createDedicatedOperations()
  try {
    await assert.rejects(scope.run(() => requestDedicatedJson(12345, '/api/health', {
      requestImpl: fixture.requestImpl, joinTimeoutMs: 30,
    })), error => { assert.equal(error.evidence.cleanupConfirmed, false); return true })
    await assert.rejects(scope.close(), { code: 'DEDICATED_CLEANUP_UNCONFIRMED' })
  } finally { fixture.release() }
})
